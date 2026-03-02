import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

import { buscarMemoria, salvarMemoria } from "./brain/memoriaAtendimento.js";
import { decidirProximoPasso } from "./brain/decisorIA.js";

import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/*
========================================
CRIAR EMPRESA
========================================
*/
app.post("/empresa/criar", async (req, res) => {
  try {
    const { nome, evolution_instance, evolution_api_key } = req.body;

    if (!nome || !evolution_instance || !evolution_api_key) {
      return res.status(400).json({ erro: "Dados incompletos" });
    }

    const { data: empresa, error: erroEmpresa } = await supabase
      .from("empresas")
      .insert([{ nome }])
      .select()
      .single();

    if (erroEmpresa) {
      return res.status(500).json({ erro: erroEmpresa.message });
    }

    const { error: erroConexao } = await supabase
      .from("conexoes_whatsapp")
      .insert([
        {
          empresa_id: empresa.id,
          evolution_instance,
          evolution_api_key,
        },
      ]);

    if (erroConexao) {
      return res.status(500).json({ erro: erroConexao.message });
    }

    res.json({
      sucesso: true,
      empresa_id: empresa.id,
    });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

/*
========================================
WEBHOOK
========================================
*/
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (!body?.data) return res.status(200).send("IGNORADO");

    const instanceName = body?.instance;

    const { data: conexao } = await supabase
      .from("conexoes_whatsapp")
      .select("*")
      .eq("evolution_instance", instanceName)
      .maybeSingle();

    if (!conexao) return res.status(400).send("Empresa não encontrada");

    const empresaId = conexao.empresa_id;

    const telefone =
      body?.data?.key?.remoteJid?.replace("@c.us", "") ||
      body?.data?.key?.remoteJid?.replace("@lid", "") ||
      null;

    let mensagem = null;

    if (body?.data?.message?.conversation) {
      mensagem = body.data.message.conversation;
    } else if (body?.data?.message?.extendedTextMessage?.text) {
      mensagem = body.data.message.extendedTextMessage.text;
    }

    if (!telefone || !mensagem)
      return res.status(200).send("IGNORADO");

    // 🔥 SALVA ENTRADA
    await supabase.from("mensagens").insert([
      {
        empresa_id: empresaId,
        telefone,
        direcao: "entrada",
        conteudo: mensagem,
      },
    ]);

    const memoriaAtual = await buscarMemoria(empresaId, telefone);

    const decisaoIA = await decidirProximoPasso({
      atendimento: memoriaAtual,
      mensagem,
    });

    await salvarMemoria(empresaId, telefone, {
      status: decisaoIA.novoStatus,
      contexto: decisaoIA.contexto,
    });

    // 🔥 SALVA SAÍDA
    await supabase.from("mensagens").insert([
      {
        empresa_id: empresaId,
        telefone,
        direcao: "saida",
        conteudo: decisaoIA.resposta,
      },
    ]);

    const url = `${process.env.EVOLUTION_URL}/message/sendText/${instanceName}`;

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: conexao.evolution_api_key,
      },
      body: JSON.stringify({
        number: telefone,
        text: decisaoIA.resposta,
      }),
    });

    res.status(200).send("OK");
  } catch (err) {
    console.log(err);
    res.status(500).send("ERRO");
  }
});

app.listen(PORT, () => {
  console.log("Brain multiempresa online");
});
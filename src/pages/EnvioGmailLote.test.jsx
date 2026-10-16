// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";

// O que se prova aqui: a CAMPANHA de e-mail em lote nao tabula. O unico
// efeito no banco e a movimentacao ACAO_MASSIVA_EXTERNA_EMAIL -- quem avanca
// data_ultimo_acionamento e o gatilho, e ninguem grava data_retorno,
// status_jornada nem status_acionamento por fora.
//
// Antes desta regra a tela gravava `data_retorno = +10 dias uteis` e
// `status_jornada = RETORNAR_DEPOIS` direto em `alunos`, o que escondia o
// aluno das Acoes Massivas atras de um "retorno agendado" que ninguem
// agendou (medicao de 15/10: 96,5% dos retornos futuros eram automaticos).

const insertMock = vi.fn();
const alunosTocado = vi.fn();
const rpcMock = vi.fn();

const TEMPLATES = [
  {
    chave: "aviso_mensalidades_aberto", situacao: "Aviso de mensalidades em aberto",
    assunto: "Aviso {{nome}}", corpo_html: "<p>Oi {{nome}}</p>", corpo_texto: "Oi {{nome}}",
    permite_anexo: false, ordem: 1, dias_retorno: 10,
  },
];
const CANDIDATOS = [{ id: "aluno-1", nome: "Ana Teste", email: "ana@x.com", valor: 100 }];

let gteRecebido = null;

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: {
      getUser: async () => ({
        data: { user: { email: "cobranca03@aelbra.com.br", user_metadata: { nome: "Olga" } } },
      }),
    },
    rpc: async (nome, args) => { rpcMock(nome, args); return { data: CANDIDATOS }; },
    from: (tabela) => {
      if (tabela === "email_templates") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: TEMPLATES }) }) }) };
      }
      if (tabela === "aluno_movimentacoes") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ gte: async (_col, valor) => { gteRecebido = valor; return { count: 0 }; } }) }),
          }),
          insert: async (linha) => insertMock(linha),
        };
      }
      // A tela NAO pode tocar em `alunos`: a campanha nao tabula.
      if (tabela === "alunos") {
        alunosTocado(tabela);
        return { update: () => ({ eq: async () => ({ error: null }) }) };
      }
      throw new Error("tabela inesperada: " + tabela);
    },
  },
}));

import EnvioGmailLote from "./EnvioGmailLote";

beforeEach(() => {
  insertMock.mockClear();
  alunosTocado.mockClear();
  rpcMock.mockClear();
  gteRecebido = null;
  window.open = vi.fn();
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { write: vi.fn(async () => {}) },
  });
  window.ClipboardItem = function ClipboardItem() {};
});

afterEach(() => cleanup());

async function montar() {
  await act(async () => { render(<EnvioGmailLote />); });
}

describe("Envio pelo Gmail em lote", () => {
  it("registra a movimentacao e NAO escreve na ficha do aluno", async () => {
    await montar();
    await act(async () => { fireEvent.click(screen.getByText(/Abrir no Gmail e registrar/)); });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const linha = insertMock.mock.calls[0][0];
    expect(linha.tipo).toBe("ACAO_MASSIVA_EXTERNA_EMAIL");
    expect(linha.aluno_id).toBe("aluno-1");
    expect(linha.registrado_por_email).toBe("cobranca03@aelbra.com.br");

    // o coracao do teste
    expect(alunosTocado).not.toHaveBeenCalled();
  });

  it("nao manda nenhum campo de retorno ou de jornada na movimentacao", async () => {
    await montar();
    await act(async () => { fireEvent.click(screen.getByText(/Abrir no Gmail e registrar/)); });

    const linha = insertMock.mock.calls[0][0];
    for (const campo of ["data_retorno", "status_jornada", "status_atual", "status_acionamento", "proxima_acao"]) {
      expect(linha[campo]).toBeUndefined();
    }
  });

  // A fila desta tela nao passa pelo universo, entao nao herda a recencia por
  // canal. Tirar a escrita de data_retorno (o que esta tela fazia de errado)
  // levaria junto o unico freio de repeticao que ela tinha -- por isso o
  // cooldown precisa vir explicito na chamada.
  it("pede a fila com cooldown de 10 dias, nao com null", async () => {
    await montar();
    expect(rpcMock).toHaveBeenCalledWith("buscar_candidatos_acoes_massivas", expect.anything());
    const [, args] = rpcMock.mock.calls[0];
    expect(args.p_dias_minimo_sem_contato).toBe(10);
    expect(args.p_apenas_nunca_acionado).toBe(false);
  });

  it("conta os enviados do dia pela virada de Brasilia, nao pela de UTC", async () => {
    await montar();
    // o corte tem de carregar o fuso explicito; sem ele o dia virava as 21h
    expect(gteRecebido).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00-03:00$/);
    const esperado = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(gteRecebido.slice(0, 10)).toBe(esperado);
  });
});

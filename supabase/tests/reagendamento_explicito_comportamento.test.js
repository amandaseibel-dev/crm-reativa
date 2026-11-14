// REAGENDAMENTO EXPLICITO, PORTAO DO RECALCULO E BACKUP -- fluxo real em PGlite
// =============================================================================
// Roda o corpo VIVO de producao (lido em 13/11/2026, fixture byte a byte), o
// gatilho e a RPC de confirmacao reais, e os DOIS arquivos do pacote:
//   1. 20261113120000_retorno_tratado_nao_herda_selo_do_operador.sql.pendente
//   2. 20261114120000_agenda_reagendar_retorno_e_portao_recalculo.sql.pendente
// Depois dos dois, roda os rollbacks e confere o estado original.
//
// Sessao de usuario: auth.uid()/auth.email() leem `teste.uid` e `teste.email`
// (set_config). Sem `teste.uid`, a chamada se comporta como cron/backend.
//
// O QUE ESTE TESTE NAO PROVA (declarado): concorrencia real entre duas sessoes.
// PGlite tem uma conexao so. Quem prova a corrida e a rodada de staging do
// pacote (duas sessoes reais, RPC x recalculo na mesma linha). Aqui o que se
// prova e que a RPC trava a linha (`for update`) e que o trecho esta no texto.
//
// NENHUM DADO REAL: nomes, telefones e ids sao inventados.
import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { retornosAgendados, retornosAtrasados, JANELA_RETORNOS_DIAS } from "../../src/utils/painelMeuDia";
import { retornoParaAvisar } from "../../src/utils/alarmeRetorno";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, "..", ...p), "utf8");
const lerRaiz = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const md5 = (t) => createHash("md5").update(t, "utf8").digest("hex");

const MD5_VIVO = "41475103b8b7ad363dfdc76c4170c5a8";
const MD5_PARTE1 = "03dacc0abb23490a8e060c4f86e0df94";
const MD5_PORTAO = "42e9ddf7d9393d12e6d4078c14a6a2f1";

const CORPO_VIVO = ler("tests", "fixtures", "recalcular_situacao_aluno_prod_20261113.sql");
const AGENDA_CONFIRMADO = ler("migrations", "20260808150000_agenda_retorno_confirmado.sql");
const P1 = "supabase/aguardando_aprovacao/20261113120000_retorno_tratado_nao_herda_selo_do_operador";
const P2 = "supabase/aguardando_aprovacao/20261114120000_agenda_reagendar_retorno_e_portao_recalculo";
const P1_PEND = lerRaiz(`${P1}.sql.pendente`);
const P1_ROLL = lerRaiz(`${P1}.rollback.sql`);
const P2_PEND = lerRaiz(`${P2}.sql.pendente`);
const P2_ROLL = lerRaiz(`${P2}.rollback.sql`);

const OPERADOR = "operador.teste@exemplo.local";
const OUTRO = "outro.operador@exemplo.local";
const GESTAO = "amanda.seibel@aelbra.com.br";
const ALUNA = "a1000000-0000-4000-8000-000000000001";
const OUTRA = "a1000000-0000-4000-8000-000000000002";

const ESQUEMA = `
  create role anon;
  create role authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('teste.uid', true), '')::uuid $$;
  create function auth.email() returns text language sql stable
    as $$ select nullif(current_setting('teste.email', true), '') $$;

  create table public.alunos (
    id uuid primary key, nome text, telefone text, responsavel_atual_email text,
    status_baixa_pagamento text, status_acionamento text, data_ultimo_acionamento timestamptz,
    data_retorno date, hora_retorno text, retorno_origem text,
    retorno_prioritario boolean default false, retorno_confirmado_em timestamptz,
    nivel_criticidade text, situacao_operacional text, proxima_acao text,
    saldo_vencido numeric, saldo_total numeric, valor_em_aberto numeric, observacao text
  );
  create table public.casos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid,
    status_termo text default 'Sem termo', termo_status_validacao text, criticidade text,
    situacao_operacional text, proxima_acao_automatica text, proximo_vencimento date,
    parcela_a_vencer numeric, parcelas_vencidas int, saldo_vencido numeric, saldo_total numeric,
    data_retorno date, quitado_em timestamptz, caso_atualizado_em timestamptz
  );
  create table public.acordos (id uuid primary key, aluno_id uuid, status text, criado_em timestamptz default now());
  create table public.pagamentos (aluno_id uuid, data_pagamento date);
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(), acordo_id uuid, numero int, valor numeric,
    vencimento date, status text, is_entrada boolean
  );
  create table public.acordos_titulos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid, situacao text, status text,
    tipo_boleto text, vencimento date, valor_cobranca_ajustado numeric, saldo_corrigido numeric,
    valor_em_aberto numeric, valor_original numeric, origem_encerramento text,
    origem_encerramento_em timestamptz, atualizado_em timestamptz, created_at timestamptz default now()
  );
  create table public.acordo_titulo_vinculo (titulo_id uuid, acordo_id uuid, ativo boolean default true);
  create table public.solicitacoes_confirmacao_pagamento (aluno_id text, status text);
  create table public.calibragem_parametros (chave text primary key, valor jsonb);
  create table public.retorno_acordo_auto (
    aluno_id uuid, proximo_vencimento date, data_retorno date, valor numeric, lote text,
    gerado_em timestamptz default now(), unique (aluno_id, proximo_vencimento)
  );
  create table public.auditoria (acao text, detalhes jsonb);
  create table public.aluno_movimentacoes (tipo text, descricao text);
  create function public.titulo_superado_por_acordo(uuid, date) returns boolean language sql as $$ select false $$;
  create function public.calibragem_nivel_criticidade(int, int, numeric, boolean, boolean, jsonb)
    returns text language sql as $$ select 'ATENCAO'::text $$;
  create function public.parcela_viva(text) returns boolean language sql immutable
    as $$ select upper(coalesce($1,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') $$;
  create function public.fmt_brl(numeric) returns text language sql as $$ select 'R$ ' || $1::text $$;
  create function public.dia_util_anterior_ou_igual(date) returns date language sql as $$ select $1 $$;
`;

// Sessao de usuario (ou nenhuma, para cron/backend).
const UID = {
  [OPERADOR]: "00000000-0000-4000-8000-0000000000a1",
  [OUTRO]: "00000000-0000-4000-8000-0000000000b2",
  [GESTAO]: "00000000-0000-4000-8000-0000000000c3",
};
const como = (db, email) =>
  db.exec(
    email
      ? `select set_config('teste.email', '${email}', false), set_config('teste.uid', '${UID[email]}', false);`
      : `select set_config('teste.email', '', false), set_config('teste.uid', '', false);`
  );

// Gravacao ANTIGA da tela (sem a RPC): o que a tela fazia antes do pacote.
async function gravarRetornoAntigo(db, id, dias, hora) {
  await db.query(
    `update public.alunos set data_retorno = current_date + $2::int, hora_retorno = $3, retorno_origem = 'OPERADOR' where id = $1`,
    [id, dias, hora]
  );
}

async function montar({ comPacote }) {
  const db = new PGlite();
  await db.exec(ESQUEMA);
  await db.exec(AGENDA_CONFIRMADO);
  await db.exec(CORPO_VIVO);
  await db.exec("grant execute on function public.recalcular_situacao_aluno(uuid, text) to authenticated;");
  if (comPacote) {
    await db.exec(P1_PEND);
    await db.exec(P2_PEND);
  }
  for (const [id, nome, dono] of [
    [ALUNA, "Aluna Ficticia Um", OPERADOR],
    [OUTRA, "Aluna Ficticia Dois", OUTRO],
  ]) {
    await db.query(
      `insert into public.alunos (id, nome, telefone, responsavel_atual_email, data_ultimo_acionamento, observacao)
       values ($1, $2, '(51) 90000-0000', $3, now() - interval '3 days', 'obs inicial')`,
      [id, nome, dono]
    );
    await db.query("insert into public.casos (aluno_id) values ($1)", [id]);
    await db.query(
      `insert into public.acordos_titulos (aluno_id, situacao, status, tipo_boleto, vencimento, valor_original)
       values ($1, 'ABERTO', 'aberta', 'Mensalidade', current_date - 40, 500)`,
      [id]
    );
  }
  await como(db, null);
  await recalcularTodos(db);
  return db;
}

const recalcularTodos = (db) =>
  db.exec("select public.recalcular_situacao_aluno(id, 'virada_teste') from public.alunos;");

const md5Corpo = async (db) =>
  (await db.query("select md5(prosrc) as m from pg_proc where oid = 'public.recalcular_situacao_aluno(uuid,text)'::regprocedure")).rows[0].m;

const linha = async (db, id) =>
  (
    await db.query(
      `select data_retorno::text as data_retorno, hora_retorno, retorno_origem, retorno_prioritario,
              retorno_confirmado_em::text as confirmado, observacao
         from public.alunos where id = $1`,
      [id]
    )
  ).rows[0];

// A tela, quando o operador marca "Reagendar": grava a ficha e chama a RPC.
async function reagendar(db, email, id, dias, hora) {
  await como(db, email);
  await db.query("select public.agenda_reagendar_retorno($1, current_date + $2::int, $3, false)", [id, dias, hora]);
  await como(db, null);
}

// A tela, ao salvar SEM "Reagendar": grava so o que mudou (aqui, a observacao).
async function salvarFichaSemReagendar(db, email, id) {
  await como(db, email);
  await db.query("update public.alunos set observacao = 'obs nova' where id = $1", [id]);
  await como(db, null);
}

async function amanhece(db) {
  await db.exec(`
    alter table public.alunos disable trigger user;
    update public.alunos
       set data_retorno = data_retorno - 1,
           data_ultimo_acionamento = data_ultimo_acionamento - interval '1 day',
           retorno_confirmado_em = retorno_confirmado_em - interval '1 day';
    update public.acordos_titulos set vencimento = vencimento - 1;
    alter table public.alunos enable trigger user;
  `);
  await como(db, null);
  await recalcularTodos(db);
}

async function avisoHoje(db, horaAgora) {
  const { rows } = await db.query(
    `select id::text as id, nome, telefone, responsavel_atual_email,
            data_retorno::text as data_retorno, hora_retorno, retorno_origem, retorno_prioritario,
            retorno_confirmado_em::text as retorno_confirmado_em, current_date::text as hoje
       from public.alunos order by nome`
  );
  const hoje = rows[0].hoje;
  const semana = retornosAgendados(rows, hoje, JANELA_RETORNOS_DIAS);
  return retornoParaAvisar(semana, { hoje, horaAgora, silenciados: new Map() });
}

describe("cadeia de md5: o pacote so entra sobre o corpo que foi lido", () => {
  it("o fixture e o corpo vivo, e as duas etapas batem com os md5 previstos", () => {
    const i = CORPO_VIVO.indexOf("AS $function$") + "AS $function$".length;
    const prosrc = CORPO_VIVO.slice(i, CORPO_VIVO.lastIndexOf("$function$"));
    expect(md5(prosrc)).toBe(MD5_VIVO);
    const trocar = (sql, s) => {
      const a = sql.match(/\$a\$([\s\S]*?)\$a\$/)[1];
      const n = sql.match(/\$n\$([\s\S]*?)\$n\$/)[1];
      expect(s.split(a).length - 1).toBe(1);
      return s.split(a).join(n);
    };
    const depois1 = trocar(P1_PEND, prosrc);
    expect(md5(depois1)).toBe(MD5_PARTE1);
    expect(md5(trocar(P2_PEND, depois1))).toBe(MD5_PORTAO);
  });

  it("o rollback do pacote volta exatamente ao corpo da parte 1, e a parte 1 ao corpo vivo", async () => {
    const db = await montar({ comPacote: false });
    expect(await md5Corpo(db)).toBe(MD5_VIVO);
    await db.exec(P1_PEND);
    expect(await md5Corpo(db)).toBe(MD5_PARTE1);
    await db.exec(P2_PEND);
    expect(await md5Corpo(db)).toBe(MD5_PORTAO);
    await db.exec(P2_ROLL);
    expect(await md5Corpo(db)).toBe(MD5_PARTE1);
    await db.exec(P1_ROLL);
    expect(await md5Corpo(db)).toBe(MD5_VIVO);
  });

  it("recusa a parte 2 se a parte 1 nao foi aplicada (corpo fora da cadeia)", async () => {
    const db = await montar({ comPacote: false });
    await expect(db.exec(P2_PEND)).rejects.toThrow(/CORPO INESPERADO/);
    await db.exec("rollback;");
    expect(await md5Corpo(db)).toBe(MD5_VIVO);
  });
});

describe("reagendamento explicito e salvar a ficha (fluxo real)", () => {
  it("defeito: sem o pacote, o 'Ja falei' some na virada e o aviso volta", async () => {
    const db = await montar({ comPacote: false });
    await gravarRetornoAntigo(db, ALUNA, 0, "14:30");
    await como(db, OPERADOR);
    await db.query("select public.agenda_confirmar_retorno($1, true)", [ALUNA]);
    await como(db, null);
    await amanhece(db);
    expect((await avisoHoje(db, "14:30"))?.id).toBe(ALUNA);
  });

  it("'Ja falei' encerra o aviso e a virada nao o reabre", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "14:30");
    expect((await avisoHoje(db, "14:30"))?.id).toBe(ALUNA);
    await como(db, OPERADOR);
    await db.query("select public.agenda_confirmar_retorno($1, true)", [ALUNA]);
    await como(db, null);
    expect(await avisoHoje(db, "14:31")).toBeNull();
    for (const _ of [1, 2, 3]) {
      await amanhece(db);
      expect(await avisoHoje(db, "14:30")).toBeNull();
    }
  });

  it("salvar a ficha SEM reagendar nao zera o 'Ja falei'", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "14:30");
    await como(db, OPERADOR);
    await db.query("select public.agenda_confirmar_retorno($1, true)", [ALUNA]);
    await como(db, null);
    const antes = (await linha(db, ALUNA)).confirmado;
    expect(antes).not.toBeNull();
    await salvarFichaSemReagendar(db, OPERADOR, ALUNA);
    const depois = await linha(db, ALUNA);
    expect(depois.confirmado).toBe(antes);
    expect(depois.observacao).toBe("obs nova");
    expect(await avisoHoje(db, "14:31")).toBeNull();
  });

  it("reagendar em outra data reativa o aviso", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    await como(db, OPERADOR);
    await db.query("select public.agenda_confirmar_retorno($1, true)", [ALUNA]);
    await como(db, null);
    await reagendar(db, OPERADOR, ALUNA, 2, "08:00");
    expect((await linha(db, ALUNA)).confirmado).toBeNull();
  });

  it("reagendar na MESMA data e hora, depois do 'Ja falei', reativa o aviso (pela RPC, nao pelo gatilho)", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    await como(db, OPERADOR);
    await db.query("select public.agenda_confirmar_retorno($1, true)", [ALUNA]);
    await como(db, null);
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    const l = await linha(db, ALUNA);
    expect(`${l.retorno_origem}:${l.hora_retorno}:${l.confirmado}`).toBe("OPERADOR:10:00:null");
    await amanhece(db);
    expect((await avisoHoje(db, "10:00"))?.id).toBe(ALUNA);
  });

  it("retorno NAO tratado continua como combinado: a virada nao muda nada alem da data", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "09:15");
    await amanhece(db);
    const l = await linha(db, ALUNA);
    expect(`${l.retorno_origem}:${l.hora_retorno}:${l.confirmado}`).toBe("OPERADOR:09:15:null");
    expect((await avisoHoje(db, "09:15"))?.id).toBe(ALUNA);
  });
});

describe("negativas de acesso", () => {
  it("RPC: usuario que nao e dono nem gestao e recusado, e nada muda", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    const antes = await linha(db, ALUNA);
    await como(db, OUTRO);
    await expect(
      db.query("select public.agenda_reagendar_retorno($1, current_date, '16:00', false)", [ALUNA])
    ).rejects.toThrow(/Sem permissao/);
    await como(db, null);
    expect(await linha(db, ALUNA)).toEqual(antes);
  });

  it("RPC: sem sessao e recusada", async () => {
    const db = await montar({ comPacote: true });
    await como(db, null);
    await expect(
      db.query("select public.agenda_reagendar_retorno($1, current_date, '16:00', false)", [ALUNA])
    ).rejects.toThrow(/Sem sessao/);
  });

  it("RPC: gestao pode reagendar caso de outro operador", async () => {
    const db = await montar({ comPacote: true });
    await como(db, GESTAO);
    await db.query("select public.agenda_reagendar_retorno($1, current_date, '16:00', false)", [OUTRA]);
    await como(db, null);
    expect((await linha(db, OUTRA)).hora_retorno).toBe("16:00");
  });

  it("RPC: data nula e recusada", async () => {
    const db = await montar({ comPacote: true });
    await como(db, OPERADOR);
    await expect(db.query("select public.agenda_reagendar_retorno($1, null, null, false)", [ALUNA])).rejects.toThrow(/Informe a data/);
    await como(db, null);
  });

  it("portao do recalculo: usuario sem permissao nao recalcula o aluno de outro", async () => {
    const db = await montar({ comPacote: true });
    await como(db, OUTRO);
    await expect(db.query("select public.recalcular_situacao_aluno($1, 'teste')", [ALUNA])).rejects.toThrow(/Sem permissao para recalcular/);
    await como(db, null);
  });

  it("portao do recalculo: o dono e a gestao recalculam; sem sessao (cron) passa", async () => {
    const db = await montar({ comPacote: true });
    await como(db, OPERADOR);
    await db.query("select public.recalcular_situacao_aluno($1, 'teste')", [ALUNA]);
    await como(db, GESTAO);
    await db.query("select public.recalcular_situacao_aluno($1, 'teste')", [OUTRA]);
    await como(db, null);
    await db.query("select public.recalcular_situacao_aluno($1, 'cron')", [OUTRA]);
  });
});

describe("backup por id", () => {
  it("guarda o estado de cada aluno com retorno antes da troca, por id", async () => {
    const db = await montar({ comPacote: false });
    await gravarRetornoAntigo(db, ALUNA, 0, "10:00");
    await db.exec(P1_PEND);
    await db.exec(P2_PEND);
    const r = await db.query(
      "select aluno_id::text as id, data_retorno::text as d, hora_retorno, retorno_origem from public.retorno_backup_20261114 where aluno_id = $1",
      [ALUNA]
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].hora_retorno).toBe("10:00");
    expect(r.rows[0].retorno_origem).toBe("OPERADOR");
  });

  it("o backup nao e apagado pelo rollback", async () => {
    const db = await montar({ comPacote: false });
    await gravarRetornoAntigo(db, ALUNA, 0, "10:00");
    await db.exec(P1_PEND);
    await db.exec(P2_PEND);
    await db.exec(P2_ROLL);
    await db.exec(P1_ROLL);
    const r = await db.query("select count(*)::int as n from public.retorno_backup_20261114");
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});

describe("consistencia dos arquivos do pacote", () => {
  it("o pacote nao escreve no gatilho, nem cria cron, nem reescreve a parte 1", () => {
    const corpo = P2_PEND.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(corpo).not.toMatch(/create or replace trigger|alter table .* trigger|cron\./i);
    expect(corpo).toMatch(/for update/);
  });
});

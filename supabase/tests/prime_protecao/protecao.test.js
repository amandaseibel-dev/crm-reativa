// Regressao: autoria da rotina x autoria humana x origem desconhecida em
// prime_liquidacao_suspender e prime_liquidacao_reavaliar_pendentes.
//
// Executa no vitest do CI (npm test). Roda em PGlite (Postgres embutido): sem Docker,
// sem servico, sem producao.
//
// VERSAO TESTADA: por padrao, a migration corrigida. Com TESTE_VERSAO=baseline, testa a
// definicao anterior (baseline_funcoes_20260918230000.sql) e DEVE FALHAR nos casos de
// autoria. Essa execucao manual prova que os testes discriminam.
//
// LIMITACOES (nao aprovadas por este arquivo):
//  - sem RLS, sem grants reais: o PGlite roda como superusuario;
//  - sem concorrencia real: PGlite e processo unico (ver describe 'concorrencia' pulado);
//  - stubs: recalcular_situacao_aluno e prime_liquidacao_evidencias.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const BASELINE = process.env.TESTE_VERSAO === "baseline";
const ARQ = BASELINE
  ? new URL("./baseline_funcoes_20260918230000.sql", import.meta.url)
  : new URL("../../aguardando_aprovacao/20261112230000_prime_protege_decisao_humana.sql.pendente", import.meta.url);
const CODIGO = readFileSync(ARQ, "utf8");

const AUTOR_ROTINA = "prime_liquidacao@rotina";
const GESTAO = "gestao@teste.local";
const T = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end $$;
    create table acordos_titulos (id uuid primary key, aluno_id text, cpf text, documento text, vencimento date,
      situacao text, status text, valor_cobranca_ajustado numeric, saldo_corrigido numeric,
      valor_em_aberto numeric, valor_original numeric, atualizado_em timestamptz);
    create table prime_conferencia_decisao (titulo_id uuid primary key, decisao text not null, motivo text,
      decidido_por text, decidido_em timestamptz, motivo_entrada text, aluno_id text, cpf text, documento text,
      valor numeric, evidencia jsonb, evidencia_chave text, corroboracao text, subgrupo text, acordo_id uuid,
      acordo_numero text, revisao_obrigatoria boolean, operador_no_momento text, detectado_em timestamptz,
      situacao_anterior text, status_anterior text);
    create table casos (aluno_id text, operador_email text, encerrado_operacional boolean, caso_atualizado_em timestamptz);
    create table acordos (id uuid primary key, numero_acordo int);
    create table aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text, descricao text,
      status_anterior text, status_novo text, registrado_por_nome text, registrado_por_email text,
      registrado_em timestamptz, valor_movimentacao numeric);
    create table auditoria (id bigserial primary key, usuario text, acao text, tabela_afetada text,
      registro_id uuid, detalhes jsonb, created_at timestamp default now());
    create table prime_liquidacao_classificacao (id bigserial primary key, titulo_id uuid, aluno_id text,
      documento text, evidencia_chave text, data_liquidacao_prime date, portador int, classificacao text,
      nivel_evidencia text, motivo text, evidencia jsonb, origem_decisao text, decidido_por text,
      resultado_titulo text, pagamento_id uuid, acordo_id uuid, valor_bruto_prime numeric, valor_pago_prime numeric);
    create table ev_stub (titulo_id uuid primary key, ev jsonb);
    create function recalcular_situacao_aluno(p_aluno text, p_origem text) returns void language sql as $$ select $$;
    create function prime_liquidacao_evidencias(p_titulo uuid) returns jsonb
      language sql stable as $$ select ev from ev_stub where titulo_id = p_titulo $$;
  `);
  await db.exec(CODIGO);
});

async function titulo(n, situacao = "ABERTO") {
  await db.query(
    `insert into acordos_titulos (id, aluno_id, cpf, documento, vencimento, situacao, status, valor_original, atualizado_em)
     values ($1, $2, '00000000000', $3, '2026-08-01', $4, 'em_aberto', 100, now())`,
    [T(n), `aluno-${n}`, `DOC-${n}`, situacao]);
}
async function decisao(n, dec, quem, subgrupo = "C_SEM_PROVA") {
  await db.query(
    `insert into prime_conferencia_decisao (titulo_id, decisao, decidido_por, decidido_em, aluno_id, documento, subgrupo, detectado_em)
     values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [T(n), dec, quem, quem === null ? null : "2026-09-18 10:00:00+00", `aluno-${n}`, `DOC-${n}`, subgrupo]);
}
async function estado(n) {
  const d = (await db.query(`select decisao, decidido_por, decidido_em::text as decidido_em from prime_conferencia_decisao where titulo_id = $1`, [T(n)])).rows[0] ?? null;
  const t = (await db.query(`select situacao from acordos_titulos where id = $1`, [T(n)])).rows[0];
  return { d, situacao: t.situacao };
}
async function suspender(n, quem = "rotina") {
  return (await db.query(
    `select prime_liquidacao_suspender($1, 'C_SEM_PROVA', 'PRIME_ORIGEM_NAO_COMPROVADA', 'NENHUMA', 'teste',
       '{"prime":{"liquidado_em":"2026-09-01","cpf_confere":true}}'::jsonb, null, null, $2) as r`, [T(n), quem])).rows[0].r;
}
async function reavaliar(quem = "rotina") {
  return (await db.query(`select prime_liquidacao_reavaliar_pendentes($1) as r`, [quem])).rows[0].r;
}
async function evidencia(n, ev) {
  await db.query(`insert into ev_stub values ($1, $2::jsonb)`, [T(n), JSON.stringify(ev)]);
}
async function auditoriaBloq(n) {
  return Number((await db.query(
    `select count(*)::int n from auditoria where registro_id = $1 and acao = 'PRIME_SUSPENSAO_BLOQUEADA_DECISAO_HUMANA'`,
    [T(n)])).rows[0].n);
}

describe("suspender: fluxo legitimo", () => {
  it("titulo sem decisao vira PENDENTE da rotina e vai para EM_CONFIRMACAO", async () => {
    await titulo(1);
    const r = await suspender(1);
    expect(r.ok).toBe(true);
    const e = await estado(1);
    expect(e.d.decisao).toBe("PENDENTE");
    expect(e.d.decidido_por).toBe(AUTOR_ROTINA);
    expect(e.situacao).toBe("EM_CONFIRMACAO");
  });

  it("PENDENTE da rotina pode ser reprocessada", async () => {
    const r = await suspender(1);
    expect(r.ok).toBe(true);
  });

  it("situacao NEGOCIADO continua recusada, sem tocar", async () => {
    await titulo(2, "NEGOCIADO");
    const r = await suspender(2);
    expect(r.erro).toBe("NAO_ESTA_ABERTO");
    expect((await estado(2)).d).toBe(null);
  });

  it("REJEITADO da ROTINA pode ser reaberto por nova liquidacao valida", async () => {
    await titulo(13);
    await decisao(13, "REJEITADO", AUTOR_ROTINA);
    const r = await suspender(13);
    expect(r.ok).toBe(true);
    expect((await estado(13)).d.decisao).toBe("PENDENTE");
  });
});

describe("suspender: autoria humana nunca e sobrescrita", () => {
  for (const [dec, n] of [["VINCULADO", 3], ["REJEITADO", 4], ["ENCERRADO_ADMINISTRATIVO", 5], ["CONFIRMADO", 6], ["DEVOLVIDO", 7]]) {
    it(`decisao humana ${dec} preserva decisao, autor, data e situacao`, async () => {
      await titulo(n);
      await decisao(n, dec, GESTAO);
      const antes = await estado(n);
      const r = await suspender(n);
      expect(r.bloqueado).toBe("DECISAO_HUMANA_PRESERVADA");
      const depois = await estado(n);
      expect(depois.d.decisao).toBe(dec);
      expect(depois.d.decidido_por).toBe(GESTAO);
      expect(depois.d.decidido_em).toBe(antes.d.decidido_em);
      expect(depois.situacao).toBe("ABERTO");
      expect(await auditoriaBloq(n)).toBe(1);
    });
  }

  it("REJEITADO com autor humano (e-mail) e tratado como humano", async () => {
    await titulo(14);
    await decisao(14, "REJEITADO", GESTAO);
    expect((await suspender(14)).bloqueado).toBe("DECISAO_HUMANA_PRESERVADA");
  });

  it("PENDENTE com autor humano e tratada como humana", async () => {
    await titulo(8);
    await decisao(8, "PENDENTE", GESTAO);
    expect((await suspender(8)).bloqueado).toBe("DECISAO_HUMANA_PRESERVADA");
    expect((await estado(8)).d.decidido_por).toBe(GESTAO);
  });

  it("decisao com valor DESCONHECIDO e tratada como humana", async () => {
    await titulo(16);
    await decisao(16, "ESTADO_NOVO", GESTAO);
    expect((await suspender(16)).bloqueado).toBe("DECISAO_HUMANA_PRESERVADA");
  });

  it("REJEITADO sem autor (estado desconhecido) e tratado como humano", async () => {
    await titulo(15);
    await decisao(15, "REJEITADO", null);
    expect((await suspender(15)).bloqueado).toBe("DECISAO_HUMANA_PRESERVADA");
  });

  it("tentativas repetidas no mesmo dia geram UMA auditoria por titulo", async () => {
    for (let i = 0; i < 5; i++) await suspender(3);
    expect(await auditoriaBloq(3)).toBe(1);
  });
});

describe("suspender: origem desconhecida (PENDENTE sem autor)", () => {
  it("PENDENTE sem autor e protegida temporariamente, sem virar humana", async () => {
    await titulo(20);
    await decisao(20, "PENDENTE", null);
    const r = await suspender(20);
    expect(r.bloqueado).toBe("ORIGEM_DESCONHECIDA_PRESERVADA");
    const e = await estado(20);
    expect(e.d.decisao).toBe("PENDENTE");
    expect(e.d.decidido_por).toBe(null);
    expect(e.situacao).toBe("ABERTO");
  });
});

describe("reavaliar: so mexe em PENDENTE da rotina", () => {
  it("reverte PENDENTE da rotina quando a Prime reverte a liquidacao", async () => {
    await titulo(10, "EM_CONFIRMACAO");
    await decisao(10, "PENDENTE", AUTOR_ROTINA);
    await evidencia(10, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k10" });
    const r = await reavaliar();
    expect(r.revertidas_pela_prime).toBe(1);
    const e = await estado(10);
    expect(e.situacao).toBe("ABERTO");
    expect(e.d.decisao).toBe("REJEITADO");
  });

  it("a reversao grava a AUTORIA DA ROTINA, nunca quem chamou", async () => {
    await titulo(18, "EM_CONFIRMACAO");
    await decisao(18, "PENDENTE", AUTOR_ROTINA);
    await evidencia(18, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k18" });
    await reavaliar(GESTAO);
    const e = await estado(18);
    expect(e.d.decisao).toBe("REJEITADO");
    expect(e.d.decidido_por).toBe(AUTOR_ROTINA);
  });

  it("NAO reabre titulo com decisao HUMANA", async () => {
    await titulo(11, "EM_CONFIRMACAO");
    await decisao(11, "PENDENTE", GESTAO);
    await evidencia(11, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k11" });
    await reavaliar();
    const e = await estado(11);
    expect(e.situacao).toBe("EM_CONFIRMACAO");
    expect(e.d.decidido_por).toBe(GESTAO);
  });

  it("NAO toca PENDENTE sem autor (origem desconhecida)", async () => {
    await titulo(21, "EM_CONFIRMACAO");
    await decisao(21, "PENDENTE", null);
    await evidencia(21, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k21" });
    await reavaliar();
    const e = await estado(21);
    expect(e.situacao).toBe("EM_CONFIRMACAO");
    expect(e.d.decidido_por).toBe(null);
  });

  it("NAO altera REJEITADO humano", async () => {
    await titulo(12, "EM_CONFIRMACAO");
    await decisao(12, "REJEITADO", GESTAO);
    await evidencia(12, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k12" });
    await reavaliar();
    const e = await estado(12);
    expect(e.d.decisao).toBe("REJEITADO");
    expect(e.d.decidido_por).toBe(GESTAO);
  });

  it("informa quantas linhas humanas ou de origem desconhecida ficaram de fora", async () => {
    const r = await reavaliar();
    expect(r).toHaveProperty("ignoradas_decisao_humana");
    expect(r.ignoradas_decisao_humana).toBeGreaterThanOrEqual(1);
  });
});

describe("estrutura (nao substitui concorrencia real)", () => {
  it("suspender trava o titulo antes da decisao", () => {
    const fn = CODIGO.slice(CODIGO.indexOf("function public.prime_liquidacao_suspender"));
    const a = fn.indexOf("from public.acordos_titulos t where t.id = p_titulo_id for update");
    const b = fn.indexOf("from public.prime_conferencia_decisao d where d.titulo_id = p_titulo_id for update");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
  });

  it("reavaliar trava o titulo antes da decisao e percorre por titulo_id", () => {
    const fn = CODIGO.slice(CODIGO.indexOf("function public.prime_liquidacao_reavaliar_pendentes"));
    const a = fn.indexOf("from public.acordos_titulos t where t.id = d.titulo_id for update");
    const b = fn.indexOf("where x.titulo_id = d.titulo_id for update");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(fn).toMatch(/order by x\.titulo_id/);
  });

  it("ON CONFLICT protegido pela condicao de autoria da rotina", () => {
    expect(CODIGO).toMatch(/where public\.prime_conferencia_decisao\.decidido_por = c_autor_rotina/);
  });

  it("DEFAULT da assinatura de reavaliar preservado", () => {
    expect(CODIGO).toMatch(/prime_liquidacao_reavaliar_pendentes\(p_quem text default 'prime_liquidacao@rotina'\)/);
  });

  it("ACL restaurada (EXECUTE so para service_role)", () => {
    expect(CODIGO).toMatch(/revoke all on function public\.prime_liquidacao_suspender[\s\S]*from public, anon, authenticated/);
    expect(CODIGO).toMatch(/grant execute on function public\.prime_liquidacao_suspender[\s\S]*to service_role/);
    expect(CODIGO).toMatch(/grant execute on function public\.prime_liquidacao_reavaliar_pendentes[\s\S]*to service_role/);
  });
});

// Casos que EXIGEM Postgres real. Marcados como pulados: NAO sao aprovacao.
describe.skip("concorrencia (PENDENTE em Postgres isolado, duas sessoes)", () => {
  it("suspender bloqueia enquanto a sessao humana segura a trava", () => {});
  it("reavaliar x encerramento administrativo: ordem de travas sem deadlock", () => {});
});
describe.skip("grants e RLS reais por perfil (anon, authenticated, service_role)", () => {
  it("anon e authenticated nao executam", () => {});
});

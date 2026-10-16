// GIRO: o evento administrativo na ficha do aluno -- comportamento.
//
// Postgres real (PGlite). O bloco do backfill e lido do PROPRIO arquivo da
// migration, nao copiado: se alguem mudar a regra de selecao ou as checagens,
// e o texto novo que roda aqui.
//
// Dubles minimos: calibragem_auditoria e aluno_movimentacoes com as colunas que
// o backfill toca, mais o indice unico parcial de producao
// `ux_aluno_mov_lote_aluno (lote_id, aluno_id) where lote_id is not null`, que
// e o que garante um registro por aluno por giro.
//
// NENHUM DADO REAL: tudo inventado.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const BACKFILL = readFileSync(
  resolve(
    RAIZ,
    "supabase/migrations/20261016200500_giro_2026_10_backfill_movimentacao_administrativa.sql",
  ),
  "utf8",
);

const SIM = "437f434b-e781-4357-a5ef-3fcd8e9d4770";

const bloco = (() => {
  const m = BACKFILL.match(/do \$mig\$[\s\S]*?end \$mig\$;/);
  if (!m) throw new Error("bloco do backfill nao encontrado na migration");
  return m[0];
})();

async function bancada() {
  const db = new PGlite();
  await db.exec(`
    create table public.calibragem_auditoria (
      id uuid primary key default gen_random_uuid(),
      simulacao_id uuid,
      evento text,
      caso_id uuid default gen_random_uuid(),
      aluno_id uuid,
      operador_anterior_email text,
      operador_anterior_nome text,
      operador_novo_email text,
      operador_novo_nome text,
      registrado_em timestamptz default now()
    );
    create table public.aluno_movimentacoes (
      id uuid primary key default gen_random_uuid(),
      aluno_id uuid,
      tipo text,
      descricao text,
      operador_anterior_nome text,
      operador_anterior_email text,
      operador_novo_nome text,
      operador_novo_email text,
      registrado_por_nome text,
      registrado_por_email text,
      registrado_em timestamptz,
      lote_id uuid
    );
    create unique index ux_aluno_mov_lote_aluno
      on public.aluno_movimentacoes (lote_id, aluno_id) where lote_id is not null;
  `);
  return db;
}

// Um aluno por letra, para a asserção ficar legível.
const ALUNO = {
  pool: "11111111-1111-1111-1111-111111111111",
  troca: "22222222-2222-2222-2222-222222222222",
  mesmo: "33333333-3333-3333-3333-333333333333",
  duasFichas: "44444444-4444-4444-4444-444444444444",
  soPulado: "55555555-5555-5555-5555-555555555555",
};

async function semear(db) {
  await db.exec(`
    insert into public.calibragem_auditoria
      (simulacao_id, evento, aluno_id, operador_anterior_email, operador_anterior_nome,
       operador_novo_email, operador_novo_nome, registrado_em)
    values
      -- veio do pool: sem responsavel anterior
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.pool}',
       null, null, 'op1@x.com', 'Operador Um', timestamptz '2026-10-16 12:00:00+00'),
      -- troca real entre operadores
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.troca}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:01:00+00'),
      -- ja era do mesmo operador: NAO deve virar transferencia
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.mesmo}',
       'op3@x.com', 'Operador Tres', 'op3@x.com', 'Operador Tres', timestamptz '2026-10-16 12:02:00+00'),
      -- duas fichas do mesmo aluno, mesma origem e mesmo destino: UMA linha
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.duasFichas}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:03:00+00'),
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.duasFichas}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:04:00+00'),
      -- so pulado: a transferencia dele ja esta representada em outra ficha
      ('${SIM}', 'PULADO_NIVELAMENTO', '${ALUNO.soPulado}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:05:00+00'),
      -- outro giro, outro lote: nao pode ser tocado
      ('99999999-9999-9999-9999-999999999999', 'MOVIMENTACAO_NIVELAMENTO',
       '66666666-6666-6666-6666-666666666666',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-10 10:00:00+00');
  `);
}

const linhas = async (db) =>
  (
    await db.query(
      `select aluno_id, tipo, descricao, operador_anterior_email, operador_novo_email,
              to_char(registrado_em at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as quando, lote_id
         from public.aluno_movimentacoes order by registrado_em`,
    )
  ).rows;

describe("o backfill cria o evento administrativo que faltou", () => {
  it("grava um registro por aluno com troca real, e só para eles", async () => {
    const db = await bancada();
    await semear(db);

    await db.exec(bloco);
    const r = await linhas(db);

    expect(r.length).toBe(3);
    const alunos = r.map((x) => x.aluno_id).sort();
    expect(alunos).toEqual([ALUNO.pool, ALUNO.troca, ALUNO.duasFichas].sort());

    // quem já era do mesmo operador não vira transferência fictícia
    expect(alunos).not.toContain(ALUNO.mesmo);
    // aluno que só aparece como pulado não gera linha própria
    expect(alunos).not.toContain(ALUNO.soPulado);
  });

  it("o aluno com duas fichas gera uma linha só", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    const r = (await linhas(db)).filter((x) => x.aluno_id === ALUNO.duasFichas);
    expect(r.length).toBe(1);
  });

  it("quem veio do pool é identificado como carteira geral", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    const pool = (await linhas(db)).find((x) => x.aluno_id === ALUNO.pool);
    expect(pool.descricao).toContain("Carteira geral / sem responsável anterior");
    expect(pool.descricao).toContain("Operador Um");
    expect(pool.operador_anterior_email).toBeNull();
  });

  it("o motivo e o identificador do giro ficam na descrição", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    for (const l of await linhas(db)) {
      expect(l.tipo).toBe("ALTERACAO_OPERADOR");
      expect(l.descricao).toContain("Motivo: Giro de carteira 2026/1 e 2026/2");
      expect(l.descricao).toContain(SIM);
      expect(l.lote_id).toBe(SIM);
    }
  });

  it("guarda a data ORIGINAL da transferência, não a data do backfill", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    const r = await linhas(db);
    expect(r.map((x) => x.quando)).toEqual([
      "2026-10-16 12:00",
      "2026-10-16 12:01",
      "2026-10-16 12:03",
    ]);
  });

  it("rodar duas vezes não duplica nada", async () => {
    const db = await bancada();
    await semear(db);

    await db.exec(bloco);
    const primeira = await linhas(db);
    await db.exec(bloco);
    const segunda = await linhas(db);

    expect(segunda.length).toBe(primeira.length);
    expect(segunda.map((x) => x.aluno_id)).toEqual(primeira.map((x) => x.aluno_id));
  });

  it("não toca em registros de outro giro nem em linhas existentes", async () => {
    const db = await bancada();
    await semear(db);
    // uma linha antiga, de outro lote, que não pode mudar
    await db.query(
      `insert into public.aluno_movimentacoes
         (aluno_id, tipo, descricao, registrado_em, lote_id)
       values ($1, 'REDISTRIBUICAO_SINCRONIZACAO', 'Sincronizacao automatica em tempo real (gatilho).',
               timestamptz '2026-10-16 12:00:30+00', null)`,
      [ALUNO.pool],
    );

    const antes = (await db.query(`select id, descricao from public.aluno_movimentacoes`)).rows;
    await db.exec(bloco);
    const depois = (await db.query(`select id, descricao from public.aluno_movimentacoes`)).rows;

    // a linha antiga continua lá, igual
    const velha = depois.find((x) => x.id === antes[0].id);
    expect(velha.descricao).toBe(antes[0].descricao);
    // e o backfill só acrescentou
    expect(depois.length).toBe(antes.length + 3);
  });

  it("sem o índice único, recusa o insert em vez de duplicar", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(`drop index ux_aluno_mov_lote_aluno;`);

    // O `on conflict (lote_id, aluno_id) where lote_id is not null` precisa do
    // índice parcial para existir. Sem ele o Postgres recusa o INSERT inteiro,
    // antes de gravar qualquer linha -- proteção melhor que a checagem
    // posterior, porque nem chega a duplicar.
    await expect(db.exec(bloco)).rejects.toThrow(/ON CONFLICT/i);
    const r = await linhas(db);
    expect(r.length).toBe(0);
  });
});

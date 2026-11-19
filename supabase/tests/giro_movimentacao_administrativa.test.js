// GIRO: o evento administrativo na ficha do aluno -- comportamento.
//
// Postgres real (PGlite). O bloco do backfill e lido do PROPRIO arquivo da
// migration, nao copiado: se alguem mudar a regra de selecao ou as checagens,
// e o texto novo que roda aqui.
//
// O DUPLO ESPELHA AS CONSTRAINTS DE PRODUCAO, e isso e o ponto. A primeira
// versao deste teste criou `aluno_movimentacoes` com o indice unico mas SEM a
// chave estrangeira de `lote_id` -> `acoes_massivas_lotes`. Passou verde, e a
// migration quebrou em producao. Agora a FK esta aqui, e ha um caso que prova
// que a abordagem antiga seria recusada pelo banco.
//
// NENHUM DADO REAL: tudo inventado.
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");

const COLUNA = ler("supabase/migrations/20261016210000_giro_movimentacao_coluna_propria.sql");
const BACKFILL = ler("supabase/migrations/20261016210500_giro_2026_10_backfill_movimentacao.sql");

const SIM = "437f434b-e781-4357-a5ef-3fcd8e9d4770";

const trecho = (sql, re, nome) => {
  const m = sql.match(re);
  if (!m) throw new Error(`trecho nao encontrado: ${nome}`);
  return m[0];
};

// A coluna e o indice, direto da migration.
const DDL = trecho(
  COLUNA,
  /alter table public\.aluno_movimentacoes[\s\S]*?where giro_simulacao_id is not null;/,
  "coluna + indice",
);
const bloco = trecho(BACKFILL, /do \$mig\$[\s\S]*?end \$mig\$;/, "bloco do backfill");

async function bancada({ comColuna = true } = {}) {
  const db = new PGlite();
  // Duplo com as constraints que producao tem de verdade.
  await db.exec(`
    create table public.acoes_massivas_lotes (
      id uuid primary key default gen_random_uuid(),
      canal text
    );
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
      lote_id uuid references public.acoes_massivas_lotes(id)
    );
    create unique index ux_aluno_mov_lote_aluno
      on public.aluno_movimentacoes (lote_id, aluno_id) where lote_id is not null;
  `);
  if (comColuna) await db.exec(DDL);
  return db;
}

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
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.pool}',
       null, null, 'op1@x.com', 'Operador Um', timestamptz '2026-10-16 12:00:00+00'),
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.troca}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:01:00+00'),
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.mesmo}',
       'op3@x.com', 'Operador Tres', 'op3@x.com', 'Operador Tres', timestamptz '2026-10-16 12:02:00+00'),
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.duasFichas}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:03:00+00'),
      ('${SIM}', 'MOVIMENTACAO_NIVELAMENTO', '${ALUNO.duasFichas}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:04:00+00'),
      ('${SIM}', 'PULADO_NIVELAMENTO', '${ALUNO.soPulado}',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-16 12:05:00+00'),
      ('99999999-9999-9999-9999-999999999999', 'MOVIMENTACAO_NIVELAMENTO',
       '66666666-6666-6666-6666-666666666666',
       'op1@x.com', 'Operador Um', 'op2@x.com', 'Operador Dois', timestamptz '2026-10-10 10:00:00+00');
  `);
}

const linhas = async (db) =>
  (
    await db.query(
      `select aluno_id, tipo, descricao, operador_anterior_email, operador_novo_email,
              to_char(registrado_em at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as quando,
              giro_simulacao_id, lote_id
         from public.aluno_movimentacoes order by registrado_em`,
    )
  ).rows;

describe("a lição do erro: lote_id não é identificador de giro", () => {
  it("o banco recusa usar lote_id para o giro -- é FK de ação massiva", async () => {
    const db = await bancada();
    // Exatamente o que a migration 20261016200500 tentava fazer.
    await expect(
      db.query(
        `insert into public.aluno_movimentacoes (aluno_id, tipo, lote_id)
         values ($1, 'ALTERACAO_OPERADOR', $2)`,
        [ALUNO.troca, SIM],
      ),
    ).rejects.toThrow(/foreign key|acoes_massivas_lotes/i);
  });

  it("a coluna própria aceita o mesmo identificador", async () => {
    const db = await bancada();
    await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, giro_simulacao_id)
       values ($1, 'ALTERACAO_OPERADOR', $2)`,
      [ALUNO.troca, SIM],
    );
    expect((await linhas(db)).length).toBe(1);
  });

  it("o backfill para cedo se a coluna ainda não existir", async () => {
    const db = await bancada({ comColuna: false });
    await semear(db);
    await expect(db.exec(bloco)).rejects.toThrow(/giro_simulacao_id nao existe|20261016210000/i);
  });
});

describe("o backfill cria o evento administrativo que faltou", () => {
  it("grava um registro por aluno com troca real, e só para eles", async () => {
    const db = await bancada();
    await semear(db);

    await db.exec(bloco);
    const r = await linhas(db);

    expect(r.length).toBe(3);
    const alunos = r.map((x) => x.aluno_id).sort();
    expect(alunos).toEqual([ALUNO.pool, ALUNO.troca, ALUNO.duasFichas].sort());
    expect(alunos).not.toContain(ALUNO.mesmo);
    expect(alunos).not.toContain(ALUNO.soPulado);
  });

  it("o aluno com duas fichas gera uma linha só", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    expect((await linhas(db)).filter((x) => x.aluno_id === ALUNO.duasFichas).length).toBe(1);
  });

  it("quem veio do pool é identificado como carteira geral", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    const pool = (await linhas(db)).find((x) => x.aluno_id === ALUNO.pool);
    expect(pool.descricao).toContain("Carteira geral / sem responsável anterior");
    expect(pool.operador_anterior_email).toBeNull();
  });

  it("o motivo e o identificador do giro ficam gravados", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    for (const l of await linhas(db)) {
      expect(l.tipo).toBe("ALTERACAO_OPERADOR");
      expect(l.descricao).toContain("Motivo: Giro de carteira 2026/1 e 2026/2");
      expect(l.giro_simulacao_id).toBe(SIM);
      expect(l.lote_id).toBeNull(); // não encosta no campo de ação massiva
    }
  });

  it("guarda a data ORIGINAL da transferência, não a data do backfill", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(bloco);

    expect((await linhas(db)).map((x) => x.quando)).toEqual([
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
    await db.query(
      `insert into public.aluno_movimentacoes
         (aluno_id, tipo, descricao, registrado_em)
       values ($1, 'REDISTRIBUICAO_SINCRONIZACAO', 'Sincronizacao automatica em tempo real (gatilho).',
               timestamptz '2026-10-16 12:00:30+00')`,
      [ALUNO.pool],
    );

    const antes = (await db.query(`select id, descricao from public.aluno_movimentacoes`)).rows;
    await db.exec(bloco);
    const depois = (await db.query(`select id, descricao from public.aluno_movimentacoes`)).rows;

    const velha = depois.find((x) => x.id === antes[0].id);
    expect(velha.descricao).toBe(antes[0].descricao);
    expect(depois.length).toBe(antes.length + 3);
  });

  it("sem o índice único, recusa o insert em vez de duplicar", async () => {
    const db = await bancada();
    await semear(db);
    await db.exec(`drop index ux_aluno_mov_giro_aluno;`);

    await expect(db.exec(bloco)).rejects.toThrow(/ux_aluno_mov_giro_aluno|ON CONFLICT/i);
    expect((await linhas(db)).length).toBe(0);
  });
});

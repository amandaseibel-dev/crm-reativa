// CRITICIDADE: "TERMO PENDENTE" PASSA A SIGNIFICAR TERMO PENDENTE
// =============================================================================
// Roda num PostgreSQL real (PGlite). Prova o que a migration 20261022220000
// muda e -- principalmente -- o que ela NAO muda.
//
// O QUE E REAL AQUI:
//   * `calibragem_nivel_criticidade` e copia BYTE A BYTE de producao
//     (supabase/tests/fixtures/, md5 do corpo conferido no proprio teste). E
//     ela quem decide URGENTE: testar a regra com uma versao reescrita provaria
//     o teste, nao a producao.
//   * `criticidade_rank`, idem.
//   * As REGRAS sao as vivas de `calibragem_parametros.criticidade_regras`
//     (gravadas em 03/09/2026), transcritas abaixo e conferidas contra o que a
//     migration promete nao tocar.
//   * O texto da ancora e o da troca sao LIDOS DO ARQUIVO da migration, nunca
//     retypados aqui -- se a migration mudar, o teste muda junto ou quebra.
//   * A migration e o rollback sao executados a partir dos arquivos de verdade.
//
// A FRONTEIRA, declarada: os corpos de producao de `recalcular_situacao_aluno`
// (13.357 caracteres) e `calibragem_criticidade_auto` (2.359) NAO estao
// transcritos. No lugar deles ha DUBLES que carregam o trecho do termo
// EXATAMENTE como em producao -- o `select ... into v_termo_pend ... from
// public.casos` de um, e o `with base as (select ... from public.casos)` do
// outro. Entao este teste prova: o comportamento do predicado nos dois formatos
// reais de chamada, a mecanica do patch ancorado, a idempotencia, a recusa
// quando o corpo nao e o medido, e a volta pelo rollback. NAO prova o corpo
// inteiro das duas funcoes de producao -- isso quem garante sao as tres travas
// de md5 da propria migration, medidas em producao em 22/10/2026 e registradas
// no cabecalho dela.
//
// NENHUM DADO REAL.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MIGRATION = ler("supabase/migrations/20261022220000_criticidade_termo_pendente_real.sql");
const ROLLBACK = ler("supabase/rollbacks/20261022220000_criticidade_termo_pendente_real.rollback.sql");
const FIXTURE_REGRA = ler("supabase/tests/fixtures/calibragem_nivel_criticidade.prod.sql");

// md5(prosrc) medidos em producao em 22/10/2026, em leitura.
const MD5 = {
  regra: "b0e1c029d9c35701d8caf60a0be854de",
  rank: "293b7b00d221a71d27dbfbf02ff90d25",
  recalcularAntes: "eb6b5f79a247669d50cf311c7bab47a9",
  recalcularDepois: "41475103b8b7ad363dfdc76c4170c5a8",
  calibragemAntes: "7850e7543596aff7c00c375d3d0c5a1c",
  calibragemDepois: "638d1fc4d234699ac395ff24f1f65a86",
};

// `calibragem_parametros.criticidade_regras` como esta em producao desde
// 03/09/2026. A migration NAO escreve nesta tabela -- ha teste provando.
const REGRAS = {
  pesos: {
    valor: { min: 5000, peso: 1 },
    fim_mes: { dias: 5, peso: 1 },
    dias_vencido: { min: 5, peso: 2 },
    termo_pendente: { peso: 2 },
    acionado_recente: { max: 7, peso: -2 },
    dias_sem_acionamento: { min: 10, peso: 2 },
  },
  niveis: { atencao: 1, critico: 5, urgente: 3 },
  escada_dias: { critico: 9, urgente: 8, perdendo: 10 },
};

// criticidade_rank, copia byte a byte de producao (211 caracteres de corpo).
const FIXTURE_RANK = `CREATE OR REPLACE FUNCTION public.criticidade_rank(p_nivel text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case upper(coalesce(p_nivel,''))
           when 'PERDENDO' then 4
           when 'CRITICO'  then 3
           when 'URGENTE'  then 2
           when 'ATENCAO'  then 1
           else 0
         end;
$function$;`;

// A ancora e a troca saem DO ARQUIVO da migration (delimitadores $a$ e $n$).
function trechoEntre(sql, tag) {
  const re = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`);
  const m = sql.match(re);
  if (!m) throw new Error(`delimitador $${tag}$ nao encontrado na migration`);
  return m[1];
}
const ANCORA = trechoEntre(MIGRATION, "a");
const TROCA = trechoEntre(MIGRATION, "n");

// Os dois formatos de chamada REAIS, um de cada funcao de producao.
const DUBLE_RECALCULAR = `
create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $dub$
declare
  v_termo_pend boolean := false;
begin
  select coalesce((${ANCORA}), false)
  into v_termo_pend from public.casos c where c.aluno_id=p_aluno_id limit 1;
  v_termo_pend := coalesce(v_termo_pend,false);
  return jsonb_build_object('termo_pendente', v_termo_pend);
end;
$dub$;`;

const DUBLE_CALIBRAGEM = `
create or replace function public.calibragem_criticidade_auto()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $dub$
declare v_out jsonb;
begin
  with base as (
    select (${ANCORA}) as termo_pend
      from public.casos c
  )
  select coalesce(jsonb_agg(termo_pend order by termo_pend), '[]'::jsonb) into v_out from base;
  return v_out;
end;
$dub$;`;

// Fluxo de retorno de termo: NAO entra na migration. O duble carrega a unica
// linha que importa aqui -- a escrita direta de URGENTE.
const DUBLE_RETORNO_TERMO = `
create or replace function public.sistema_retorno_termo(p_aluno_id uuid, p_status text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $dub$
begin
  update public.alunos
     set status_jornada = p_status, status_atual = p_status, nivel_criticidade = 'URGENTE',
         data_ultimo_acionamento = now()
   where id = p_aluno_id;
end;
$dub$;`;

const U = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create table public.casos (aluno_id uuid, status_termo text, termo_status_validacao text);
    create table public.alunos (id uuid primary key, nivel_criticidade text,
      status_atual text, status_jornada text, data_ultimo_acionamento timestamptz);
    ${FIXTURE_RANK}
    ${FIXTURE_REGRA}
    ${DUBLE_RECALCULAR}
    ${DUBLE_CALIBRAGEM}
    ${DUBLE_RETORNO_TERMO}
  `);
  return db;
}

const corpoMd5 = async (db, assinatura) =>
  (await db.query(`select md5(p.prosrc) as m from pg_proc p where p.oid = $1::regprocedure`, [assinatura]))
    .rows[0].m;

const corpo = async (db, assinatura) =>
  (await db.query(`select p.prosrc as s from pg_proc p where p.oid = $1::regprocedure`, [assinatura]))
    .rows[0].s;

// A migration traz os md5 de PRODUCAO. Nos dubles o corpo e outro, entao o
// teste deriva uma copia trocando SO os quatro md5 -- e prova que so isso
// mudou. Qualquer outra diferenca entre a copia e o arquivo reprova.
function derivar(sql, de, para) {
  let fora = sql;
  const trocados = [];
  for (const [velho, novo] of Object.entries(de).map(([k, v]) => [v, para[k]])) {
    const antes = fora;
    fora = fora.split(velho).join(novo);
    if (fora !== antes) trocados.push(velho);
  }
  return { sql: fora, trocados };
}

async function nivel(db, { venc = 30, dias = 0, valor = 6000, termo = false, fimMes = false } = {}) {
  const r = await db.query(
    `select public.calibragem_nivel_criticidade($1,$2,$3,$4,$5,$6::jsonb) as n`,
    [venc, dias, valor, termo, fimMes, JSON.stringify(REGRAS)]
  );
  return r.rows[0].n;
}

// Avalia o predicado (o velho ou o novo) sobre uma linha de `casos`.
async function predicado(db, expr, statusTermo, validacao) {
  await db.exec(`delete from public.casos`);
  await db.query(`insert into public.casos values ($1,$2,$3)`, [U(1), statusTermo, validacao]);
  const r = await db.query(`select coalesce((${expr}), false) as v from public.casos c`);
  return r.rows[0].v;
}

describe("a regra de criticidade e a de producao", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("os corpos copiados batem byte a byte com producao (md5)", async () => {
    expect(await corpoMd5(db, "public.calibragem_nivel_criticidade(integer,integer,numeric,boolean,boolean,jsonb)"))
      .toBe(MD5.regra);
    expect(await corpoMd5(db, "public.criticidade_rank(text)")).toBe(MD5.rank);
  });

  it("HOJE: com o termo constante TRUE, acionar nao muda a faixa (o relato da operacao)", async () => {
    for (const dias of [0, 1, 3, 5, 7]) {
      expect(await nivel(db, { dias, termo: true })).toBe("URGENTE");
    }
  });

  it("DEPOIS: sem o peso fantasma, o caso acionado na semana e ATENCAO", async () => {
    for (const dias of [0, 1, 3, 5, 7]) {
      expect(await nivel(db, { dias, termo: false })).toBe("ATENCAO");
    }
  });

  it("A ESCADA DE 8/9/10 DIAS NAO MUDA -- e o que garante que risco real segue destacado", async () => {
    for (const termo of [true, false]) {
      expect(await nivel(db, { dias: 8, termo })).toBe(termo ? "CRITICO" : "URGENTE");
      expect(await nivel(db, { dias: 9, termo })).toBe("CRITICO");
      expect(await nivel(db, { dias: 10, termo })).toBe("PERDENDO");
      expect(await nivel(db, { dias: 30, termo })).toBe("PERDENDO");
      // nunca acionado chega como 9999 e continua no topo
      expect(await nivel(db, { dias: 9999, termo })).toBe("PERDENDO");
    }
  });

  it("nenhum caso com 8 dias ou mais cai para fora da faixa alta", async () => {
    const altas = ["URGENTE", "CRITICO", "PERDENDO"];
    for (const dias of [8, 9, 10, 15, 40]) {
      for (const valor of [0, 100, 6000, 90000]) {
        expect(altas).toContain(await nivel(db, { dias, valor, termo: false }));
      }
    }
  });

  it("UM TERMO REALMENTE PENDENTE continua pesando +2 e leva a URGENTE mesmo acionado hoje", async () => {
    // Este e o ponto que a gestao pediu para comprovar: o peso nao foi removido.
    expect(await nivel(db, { dias: 0, termo: true })).toBe("URGENTE");
    expect(await nivel(db, { dias: 0, termo: false })).toBe("ATENCAO");
  });

  it("os pesos e os limiares usados sao os de producao", async () => {
    // Ancoras da regra viva (vencido>=5: +2; valor>=5.000: +1; fim de mes: +1;
    // acionado ha <=7 dias: -2; limiares 1/3/5). Se alguem mexer nos pesos ou
    // nos limiares, estas quatro caem.
    expect(await nivel(db, { venc: 0, dias: 0, valor: 0, termo: false })).toBe("NORMAL");
    expect(await nivel(db, { venc: 5, dias: 0, valor: 5000, termo: false })).toBe("ATENCAO");
    expect(await nivel(db, { venc: 5, dias: 0, valor: 5000, termo: false, fimMes: true })).toBe("ATENCAO");
    // o mesmo caso sem o desconto de acionamento recente (8 dias) sobe: o
    // score vai de 2 para 4 e a escada ja marca URGENTE no 8o dia
    expect(await nivel(db, { venc: 5, dias: 8, valor: 5000, termo: false, fimMes: true })).toBe("URGENTE");
  });

  it("DEPOIS da correcao, acionado na semana NENHUMA combinacao financeira chega a URGENTE", async () => {
    // O teto do score com acionamento recente e 2 (vencido 2 + valor 1 +
    // fim de mes 1, menos 2), e URGENTE exige 3. E por isso que a faixa deixa
    // de brigar com o acionamento: quem acionou sai do radar ate o 8o dia.
    for (const dias of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const venc of [0, 5, 400]) {
        for (const valor of [0, 5000, 90000]) {
          for (const fimMes of [false, true]) {
            expect(["NORMAL", "ATENCAO"]).toContain(await nivel(db, { venc, dias, valor, termo: false, fimMes }));
          }
        }
      }
    }
  });
});

describe("o predicado novo: o que conta como termo pendente", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("'Sem termo' deixa de ser pendente -- e a causa dos 1.013 URGENTE", async () => {
    expect(await predicado(db, ANCORA, "Sem termo", null)).toBe(true);   // hoje
    expect(await predicado(db, TROCA, "Sem termo", null)).toBe(false);   // depois
  });

  it("caixa e espaco nao escapam da regra", async () => {
    for (const v of ["SEM TERMO", "sem termo", "  Sem Termo  ", "", "   "]) {
      expect(await predicado(db, TROCA, v, null)).toBe(false);
    }
  });

  it("termo de verdade, ainda nao validado, CONTINUA pendente nos dois predicados", async () => {
    for (const v of [null, "", "Aguardando validacao", "enviado"]) {
      expect(await predicado(db, ANCORA, "Termo enviado", v)).toBe(true);
      expect(await predicado(db, TROCA, "Termo enviado", v)).toBe(true);
    }
  });

  it("termo validado, assinado ou aprovado nao e pendente -- nos dois", async () => {
    for (const v of ["validado", "Validado", "ASSINADO", "aprovado"]) {
      expect(await predicado(db, ANCORA, "Termo enviado", v)).toBe(false);
      expect(await predicado(db, TROCA, "Termo enviado", v)).toBe(false);
    }
  });

  it("status nulo nao e pendente em nenhum dos dois (nao e isso que muda)", async () => {
    expect(await predicado(db, ANCORA, null, null)).toBe(false);
    expect(await predicado(db, TROCA, null, null)).toBe(false);
  });
});

describe("a mecanica do patch ancorado", () => {
  let db;
  let derivada;
  let desfazer;

  beforeEach(async () => {
    db = await novoBanco();
    const de = {
      recalcularAntes: MD5.recalcularAntes, recalcularDepois: MD5.recalcularDepois,
      calibragemAntes: MD5.calibragemAntes, calibragemDepois: MD5.calibragemDepois,
    };
    const antesR = await corpoMd5(db, "public.recalcular_situacao_aluno(uuid,text)");
    const antesC = await corpoMd5(db, "public.calibragem_criticidade_auto()");
    const prever = async (assinatura) =>
      (await db.query(
        `select md5(replace(p.prosrc, $2, $3)) as m from pg_proc p where p.oid = $1::regprocedure`,
        [assinatura, ANCORA, TROCA]
      )).rows[0].m;
    const para = {
      recalcularAntes: antesR,
      recalcularDepois: await prever("public.recalcular_situacao_aluno(uuid,text)"),
      calibragemAntes: antesC,
      calibragemDepois: await prever("public.calibragem_criticidade_auto()"),
    };
    derivada = derivar(MIGRATION, de, para);
    desfazer = derivar(ROLLBACK, de, para);
  });

  it("a copia executavel difere da migration APENAS nos quatro md5", () => {
    expect(derivada.trocados).toHaveLength(4);
    expect(derivada.sql).not.toBe(MIGRATION);
    // A prova forte: apagando TODO md5 dos dois textos, eles ficam identicos --
    // ou seja, a copia executavel nao mexeu em mais nada do arquivo.
    const semHex = (s) => s.replace(/\b[0-9a-f]{32}\b/g, "<md5>");
    expect(semHex(derivada.sql)).toBe(semHex(MIGRATION));
    // e os quatro md5 de producao realmente sairam
    for (const v of [MD5.recalcularAntes, MD5.recalcularDepois, MD5.calibragemAntes, MD5.calibragemDepois]) {
      expect(derivada.sql).not.toContain(v);
    }
  });

  it("aplica nas duas funcoes e NADA fora da ancora se move", async () => {
    const antes = {
      r: await corpo(db, "public.recalcular_situacao_aluno(uuid,text)"),
      c: await corpo(db, "public.calibragem_criticidade_auto()"),
    };
    await db.exec(derivada.sql);
    const depois = {
      r: await corpo(db, "public.recalcular_situacao_aluno(uuid,text)"),
      c: await corpo(db, "public.calibragem_criticidade_auto()"),
    };
    for (const k of ["r", "c"]) {
      expect(depois[k]).toContain(TROCA);
      expect(depois[k]).not.toContain(ANCORA);
      // desfazendo SO a troca, volta exatamente ao corpo anterior
      expect(depois[k].split(TROCA).join(ANCORA)).toBe(antes[k]);
    }
  });

  it("depois do patch, 'Sem termo' deixa de ser pendente nos DOIS formatos de chamada", async () => {
    await db.query(`insert into public.casos values ($1,$2,$3)`, [U(1), "Sem termo", null]);
    await db.query(`insert into public.alunos (id) values ($1)`, [U(1)]);

    const antesR = await db.query(`select public.recalcular_situacao_aluno($1) as j`, [U(1)]);
    expect(antesR.rows[0].j.termo_pendente).toBe(true);
    const antesC = await db.query(`select public.calibragem_criticidade_auto() as j`);
    expect(antesC.rows[0].j).toEqual([true]);

    await db.exec(derivada.sql);

    const depoisR = await db.query(`select public.recalcular_situacao_aluno($1) as j`, [U(1)]);
    expect(depoisR.rows[0].j.termo_pendente).toBe(false);
    const depoisC = await db.query(`select public.calibragem_criticidade_auto() as j`);
    expect(depoisC.rows[0].j).toEqual([false]);
  });

  it("depois do patch, um termo REAL pendente continua pendente nos dois formatos", async () => {
    await db.query(`insert into public.casos values ($1,$2,$3)`, [U(2), "Termo enviado", null]);
    await db.query(`insert into public.alunos (id) values ($1)`, [U(2)]);
    await db.exec(derivada.sql);
    const r = await db.query(`select public.recalcular_situacao_aluno($1) as j`, [U(2)]);
    expect(r.rows[0].j.termo_pendente).toBe(true);
    const c = await db.query(`select public.calibragem_criticidade_auto() as j`);
    expect(c.rows[0].j).toEqual([true]);
  });

  it("e idempotente: rodar de novo nao quebra nem muda o corpo", async () => {
    await db.exec(derivada.sql);
    const md5Um = await corpoMd5(db, "public.recalcular_situacao_aluno(uuid,text)");
    await expect(db.exec(derivada.sql)).resolves.toBeDefined();
    expect(await corpoMd5(db, "public.recalcular_situacao_aluno(uuid,text)")).toBe(md5Um);
  });

  it("preserva SECURITY DEFINER, search_path e assinatura", async () => {
    const olhar = async () => (await db.query(`
      select p.oid::regprocedure::text as assinatura, p.prosecdef, p.proconfig::text as cfg
        from pg_proc p
       where p.oid in ('public.recalcular_situacao_aluno(uuid,text)'::regprocedure,
                       'public.calibragem_criticidade_auto()'::regprocedure)
       order by 1`)).rows;
    const antes = await olhar();
    await db.exec(derivada.sql);
    const depois = await olhar();
    expect(depois).toEqual(antes);
    for (const f of depois) {
      expect(f.prosecdef).toBe(true);
      expect(f.cfg).toContain("search_path=public");
    }
  });

  it("FALHA FECHADO: com o corpo diferente do medido, a migration de verdade recusa", async () => {
    // A migration real carrega os md5 de PRODUCAO; aqui os corpos sao dubles.
    await expect(db.exec(MIGRATION)).rejects.toThrow(/CORPO INESPERADO/);
    // A excecao aborta a transacao aberta pelo `begin` da migration: fechar
    // antes de conferir qualquer coisa (e isso tambem prova que o `commit` do
    // arquivo nao chegou a rodar).
    await db.exec("rollback");
    // NADA foi tocado: os dois corpos seguem com a ancora antiga e o
    // comportamento antigo.
    expect(await corpo(db, "public.calibragem_criticidade_auto()")).toContain(ANCORA);
    expect(await corpo(db, "public.recalcular_situacao_aluno(uuid,text)")).toContain(ANCORA);
    await db.query(`insert into public.casos values ($1,$2,$3)`, [U(3), "Sem termo", null]);
    const c = await db.query(`select public.calibragem_criticidade_auto() as j`);
    expect(c.rows[0].j).toEqual([true]);
  });

  it("o rollback devolve o corpo original, byte a byte", async () => {
    const antes = await corpo(db, "public.recalcular_situacao_aluno(uuid,text)");
    const md5Antes = await corpoMd5(db, "public.recalcular_situacao_aluno(uuid,text)");
    await db.exec(derivada.sql);
    expect(await corpoMd5(db, "public.recalcular_situacao_aluno(uuid,text)")).not.toBe(md5Antes);
    await db.exec(desfazer.sql);
    expect(await corpo(db, "public.recalcular_situacao_aluno(uuid,text)")).toBe(antes);
    expect(await corpoMd5(db, "public.recalcular_situacao_aluno(uuid,text)")).toBe(md5Antes);
  });

  it("o rollback tambem e idempotente", async () => {
    await db.exec(derivada.sql);
    await db.exec(desfazer.sql);
    const md5Um = await corpoMd5(db, "public.calibragem_criticidade_auto()");
    await expect(db.exec(desfazer.sql)).resolves.toBeDefined();
    expect(await corpoMd5(db, "public.calibragem_criticidade_auto()")).toBe(md5Um);
  });

  it("O FLUXO DE RETORNO DE TERMO NAO E TOCADO", async () => {
    const antes = await corpo(db, "public.sistema_retorno_termo(uuid,text)");
    await db.query(`insert into public.alunos (id, nivel_criticidade) values ($1,'NORMAL')`, [U(9)]);
    await db.exec(derivada.sql);
    expect(await corpo(db, "public.sistema_retorno_termo(uuid,text)")).toBe(antes);
    // e continua escrevendo URGENTE quando o termo volta
    await db.query(`select public.sistema_retorno_termo($1,'TERMO_RECEBIDO_LIBERADO')`, [U(9)]);
    const r = await db.query(`select nivel_criticidade as n from public.alunos where id=$1`, [U(9)]);
    expect(r.rows[0].n).toBe("URGENTE");
  });
});

describe("escopo: o que a migration nao pode conter", () => {
  const semComentario = (sql) =>
    sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

  it("ZERO DML: nenhum insert, update ou delete fora de comentario", () => {
    for (const sql of [MIGRATION, ROLLBACK]) {
      const corpoSql = semComentario(sql);
      expect(corpoSql).not.toMatch(/\binsert\s+into\b/i);
      expect(corpoSql).not.toMatch(/\bupdate\s+public\./i);
      expect(corpoSql).not.toMatch(/\bdelete\s+from\b/i);
      expect(corpoSql).not.toMatch(/\btruncate\b/i);
    }
  });

  it("nao escreve nos parametros de calibragem: pesos, limiares e escada ficam como estao", () => {
    const corpoSql = semComentario(MIGRATION);
    expect(corpoSql).not.toMatch(/calibragem_parametros/i);
    expect(corpoSql).not.toMatch(/criticidade_regras/i);
    expect(corpoSql).not.toMatch(/escada_dias/i);
  });

  it("toca exatamente duas funcoes, e nenhuma delas e a do retorno de termo", () => {
    const corpoSql = semComentario(MIGRATION);
    const assinaturas = corpoSql.match(/'public\.[a-z_]+\([a-z, ]*\)'/g) || [];
    expect([...new Set(assinaturas)].sort()).toEqual([
      "'public.calibragem_criticidade_auto()'",
      "'public.recalcular_situacao_aluno(uuid,text)'",
    ]);
    expect(corpoSql).not.toMatch(/sistema_retorno_termo/);
    expect(corpoSql).not.toMatch(/calibragem_nivel_criticidade/);
  });

  it("nao cria, nao apaga e nao altera objeto nenhum alem do corpo das duas", () => {
    const corpoSql = semComentario(MIGRATION);
    expect(corpoSql).not.toMatch(/\bdrop\b/i);
    expect(corpoSql).not.toMatch(/\balter\s+table\b/i);
    expect(corpoSql).not.toMatch(/\bcreate\s+(table|index|trigger|policy)\b/i);
    expect(corpoSql).not.toMatch(/\b(grant|revoke)\b/i);
  });

  it("a migration e o rollback usam o MESMO par de textos, trocados de lado", () => {
    expect(MIGRATION).toContain(ANCORA);
    expect(MIGRATION).toContain(TROCA);
    expect(trechoEntre(ROLLBACK, "a")).toBe(TROCA);
    expect(trechoEntre(ROLLBACK, "n")).toBe(ANCORA);
  });
});

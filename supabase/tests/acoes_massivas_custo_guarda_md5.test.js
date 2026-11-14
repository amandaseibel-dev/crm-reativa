// Guarda de MD5 da otimizacao do universo: prova que a migration RECUSA rodar quando
// acoes_massivas_tipo_cobertura nao e a definicao testada (5dcbd09d...), e que nada muda.
import { describe, it, expect, vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco } from "./fixtures/acoes_massivas_universo/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, ...p), "utf8");
const PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261112_universo_pos_dono_do_acordo.sql");
const TIPO_PUBLICADO = ler("fixtures/acoes_massivas_valor_exigivel/prod_20261113_tipo_cobranca_alunos.sql");
const MIG941 = ler("../aguardando_aprovacao/20261112235500_acoes_massivas_valor_exigivel.sql.pendente");
const MIG_R5 = ler("../aguardando_aprovacao/20261112235600_acoes_massivas_r5_sobre_valor.sql.pendente");
const MIG_OTIM = ler("../aguardando_aprovacao/20261113230000_acoes_massivas_universo_custo.sql.pendente");
const COLUNAS = `
  alter table public.acordos add column if not exists saldo numeric default 0;
  alter table public.parcelas add column if not exists boleto text;
  alter table public.parcelas add column if not exists boleto_confiavel boolean default false;
  alter table public.parcelas add column if not exists renegociada_no_acordo_id uuid;
  alter table public.parcelas add column if not exists pago_em timestamptz;
  alter table public.acordos_titulos add column if not exists documento text;
  alter table public.prime_extrato add column if not exists cpf text;
  alter table public.prime_extrato add column if not exists boleto text;
  alter table public.prime_extrato add column if not exists liquidado_em timestamptz;
  create table if not exists public.pagamentos (aluno_id uuid, numero_parcela_completo text,
    titulo_numero text, data_pagamento timestamptz, valor_pago numeric);`;
const emTransacao = (sql) => "BEGIN;\n" + sql + "\nCOMMIT;";

const MD5_COBERTURA_TESTADA = "5dcbd09deba6197cb6948d01f8b9caa5";
const MD5_UNIVERSO_R5 = "885583bc6a45d7e3c77d7add841ac11b";
const md5De = async (db, nome) =>
  (await db.query("select md5(pg_get_functiondef(p.oid)) m from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [nome])).rows[0].m;

async function baseR5() {
  const db = await novoBanco();
  await db.exec(COLUNAS);
  await db.exec(PUBLICADO);
  await db.exec(TIPO_PUBLICADO);
  await db.exec(emTransacao(MIG941));
  await db.exec(emTransacao(MIG_R5));
  return db;
}

describe("guarda de MD5 da otimizacao: a migration recusa definicao diferente", () => {
  it("base testada: a cobertura tem o MD5 esperado pela guarda (positivo)", async () => {
    const db = await baseR5();
    expect(await md5De(db, "acoes_massivas_tipo_cobertura")).toBe(MD5_COBERTURA_TESTADA);
    expect(await md5De(db, "acoes_massivas_universo")).toBe(MD5_UNIVERSO_R5);
  });

  it("cobertura alterada (search_path fixo): a migration aborta e o universo nao muda", async () => {
    const db = await baseR5();
    // Mudanca minima que altera a definicao (proconfig: SET work_mem) sem mudar o resultado da funcao.
    await db.exec("alter function public.acoes_massivas_tipo_cobertura(text) set work_mem = '64kB';");
    const md5CoberturaAlterada = await md5De(db, "acoes_massivas_tipo_cobertura");
    expect(md5CoberturaAlterada).not.toBe(MD5_COBERTURA_TESTADA);

    let erro = null;
    try {
      await db.exec(MIG_OTIM);
    } catch (e) {
      erro = e;
    }
    await db.exec("rollback;").catch(() => {});

    expect(erro, "a migration deveria ter sido recusada").not.toBeNull();
    expect(String(erro.message)).toMatch(/nao e a definicao testada/);
    // Nada foi aplicado: o universo continua na R5 v2 (885583bc).
    expect(await md5De(db, "acoes_massivas_universo")).toBe(MD5_UNIVERSO_R5);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const MIG = readFileSync("supabase/migrations/20260921120000_projecao_importar_pagamentos_timeout_60s.sql", "utf8");
const ROLL = readFileSync("supabase/rollbacks/20260921120000_projecao_importar_pagamentos_timeout_60s.rollback.sql", "utf8");
const semComentario = (s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("projecao_importar_pagamentos: timeout proprio de 60s (estrutural)", () => {
  const sql = semComentario(MIG).toLowerCase().replace(/\s+/g, " ");
  it("faz somente um ALTER FUNCTION na sobrecarga de 7 argumentos", () => {
    expect(sql.match(/alter /g)).toHaveLength(1);
    expect(sql).toContain("alter function public.projecao_importar_pagamentos(text, text, jsonb, text, boolean, uuid, text) set statement_timeout = '60s'");
    expect(sql).not.toMatch(/create |drop |insert |update |delete |grant |revoke |cron\./);
  });
  it("nao mexe em papeis nem em timeout global", () => {
    expect(sql).not.toMatch(/alter (role|database|user)/);
    expect(sql).not.toContain("authenticated");
    expect(sql).not.toContain("authenticator");
  });
  it("o rollback so remove o timeout da mesma sobrecarga", () => {
    const r = semComentario(ROLL).toLowerCase().replace(/\s+/g, " ");
    expect(r).toContain("alter function public.projecao_importar_pagamentos(text, text, jsonb, text, boolean, uuid, text) reset statement_timeout");
    expect(r.match(/alter /g)).toHaveLength(1);
  });
});

describe("projecao_importar_pagamentos: efeito da migration e do rollback (PGlite)", () => {
  it("aplica, preserva o corpo e reverte exatamente o proconfig", async () => {
    const db = new PGlite();
    await db.exec(`
      create schema if not exists public;
      create function public.projecao_importar_pagamentos(p_arquivo_nome text, p_usuario text, p_linhas jsonb, p_mes_referencia text, p_retroativo boolean default false, p_substituir_importacao_id uuid default null, p_motivo_substituicao text default null)
        returns table(importacao_id uuid, linhas_gravadas integer) language plpgsql security definer set search_path to 'public'
        as $$ begin return query select null::uuid, 0; end $$;
      create function public.projecao_importar_pagamentos(p_arquivo_nome text, p_usuario text, p_linhas jsonb, p_retroativo boolean default false)
        returns table(importacao_id uuid, linhas_gravadas integer) language plpgsql security definer set search_path to 'public'
        as $$ begin return query select null::uuid, 0; end $$;
    `);
    const estado = async () => (await db.query(`
      select pg_get_function_identity_arguments(oid) a, prosecdef, proconfig::text cfg, md5(prosrc) corpo
        from pg_proc where proname='projecao_importar_pagamentos' order by 1`)).rows;
    const antes = await estado();
    await db.exec(MIG);
    const depois = await estado();
    const sete = (rows) => rows.find((r) => r.a.includes("p_mes_referencia"));
    const quatro = (rows) => rows.find((r) => !r.a.includes("p_mes_referencia"));
    expect(sete(depois).cfg).toBe("{search_path=public,statement_timeout=60s}");
    expect(sete(depois).corpo).toBe(sete(antes).corpo);
    expect(sete(depois).prosecdef).toBe(true);
    expect(quatro(depois)).toEqual(quatro(antes));
    await db.exec(ROLL);
    expect(await estado()).toEqual(antes);
  });
});

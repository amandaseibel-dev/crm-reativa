// MOTOR GENERICO DE BACKFILL DA MATRICULA PRIME.
//
// LIMITE, DITO DE FRENTE: o CI nao tem banco. Estes testes provam ESTRUTURA
// sobre o texto da migration -- que os invariantes existem, que vem ANTES da
// escrita, que a funcao nao e alcancavel pelo PostgREST, e sobretudo que
// NENHUM DADO PESSOAL entrou no arquivo. O repositorio e publico; o teste de
// vazamento e o mais importante deste arquivo.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const MIG = resolve(RAIZ, "supabase/migrations/20260915140000_backfill_matricula_prime_motor.sql");
const RB = resolve(RAIZ, "supabase/rollbacks/20260915140000_backfill_matricula_prime_motor.rollback.sql");
const sql = readFileSync(MIG, "utf8").replace(/\r/g, "");
const rb = readFileSync(RB, "utf8").replace(/\r/g, "");

// corpo da funcao, sem os comentarios -- varias assercoes abaixo proibem
// construcoes, e um comentario que as cita inverteria o resultado.
const corpoFn = (() => {
  const i = sql.indexOf("function public.backfill_matricula_aplicar(");
  const d = sql.slice(i);
  const a = d.indexOf("$fn$"), b = d.indexOf("$fn$", a + 4);
  return d.slice(a + 4, b);
})();
const semComentario = (t) =>
  t.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const fn = semComentario(corpoFn);
const sqlCodigo = semComentario(sql);
const pos = (t, s) => t.indexOf(s);

describe("nenhum dado pessoal no repositorio", () => {
  it("nao contem UUID nenhum (pagamento_id)", () => {
    expect(sql.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)).toBeNull();
  });
  it("nao contem CPF", () => {
    expect(sql.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g)).toBeNull();
  });
  it("nao contem matricula Prime (6 a 12 digitos isolados)", () => {
    // as unicas cifras longas admitidas sao os timestamps de migration na prosa
    const achados = (sql.match(/\b\d{6,12}\b/g) || []).filter((n) => !/^2026\d{6,8}$/.test(n));
    expect(achados).toEqual([]);
  });
  it("nao contem boleto de acordo (5 + acordo + parcela)", () => {
    expect(sql.match(/\b5\d{10}\b/g)).toBeNull();
  });
  it("nao contem hash de lote (md5 ou sha256 literal)", () => {
    expect(sql.match(/\b[0-9a-f]{32}\b/g)).toBeNull();
    expect(sql.match(/\b[0-9a-f]{64}\b/g)).toBeNull();
  });
  it("nao contem nome de arquivo de origem com dado", () => {
    expect(sql).not.toMatch(/julho total\.xlsx|agosto fechado\.xlsx/);
  });
  it("nao embute lista de VALUES", () => {
    expect(sqlCodigo).not.toMatch(/insert\s+into\s+_plano\s+values/i);
  });
  it("o plano NAO viaja como parametro -- vem da stage", () => {
    // auto_explain loga parametros por inteiro acima de 10s e nao pode ser
    // desligado por nao-superusuario. Por isso a assinatura nao tem o plano.
    expect(fn).not.toMatch(/p_plano|jsonb_array_elements/);
    expect(fn).toMatch(/from public\.backfill_matricula_stage/);
  });
  it("a assinatura tem so lote, hash e contagem", () => {
    expect(sqlCodigo).toMatch(
      /function public\.backfill_matricula_aplicar\(\s*\n?\s*p_lote\s+text,\s*\n?\s*p_hash\s+text,\s*\n?\s*p_esperado integer\s*\n?\s*\)/);
    expect(sqlCodigo).not.toMatch(/p_plano\s+jsonb/);
  });
});

describe("ACL: fora do alcance do PostgREST", () => {
  it("a funcao e SECURITY INVOKER", () => {
    expect(sqlCodigo).toMatch(/security invoker/);
    expect(sqlCodigo).not.toMatch(/security definer/);
  });
  it("revoga EXECUTE de public, anon, authenticated E service_role", () => {
    expect(sqlCodigo).toMatch(
      /revoke all on function public\.backfill_matricula_aplicar\(text, text, integer\)\s*\n?\s*from public, anon, authenticated, service_role/);
  });
  it("revoga as duas tabelas de trilha", () => {
    expect(sqlCodigo).toMatch(/revoke all on table public\.backfill_matricula_lotes\s+from public, anon, authenticated/);
    expect(sqlCodigo).toMatch(/revoke all on table public\.backfill_matricula_origem from public, anon, authenticated/);
  });
  it("liga RLS nas duas tabelas", () => {
    expect(sqlCodigo).toMatch(/alter table public\.backfill_matricula_lotes\s+enable row level security/);
    expect(sqlCodigo).toMatch(/alter table public\.backfill_matricula_origem enable row level security/);
  });
  it("nao cria policy nenhuma -- trilha e interna", () => {
    expect(sqlCodigo).not.toMatch(/create policy/i);
  });
  it("tem gate explicito, e ele e do DONO", () => {
    expect(fn).toMatch(/current_user not in \('postgres', 'supabase_admin'\)/);
    expect(fn).toMatch(/42501/);
  });
  it("o gate NAO cita service_role -- ele nao tem EXECUTE", () => {
    // so o CORPO da funcao; o bloco DO $prova$ cita service_role de proposito,
    // justamente para impedir que o gate volte a cita-lo.
    expect(fn).not.toMatch(/service_role/);
  });
  it("o gate nao depende do schema auth do Supabase", () => {
    expect(fn).not.toMatch(/auth\.role\(\)/);
  });
  it("o gate vem antes de qualquer escrita", () => {
    expect(pos(fn, "42501")).toBeLessThan(pos(fn, "pg_advisory_xact_lock"));
    expect(pos(fn, "42501")).toBeLessThan(pos(fn, "update public.pagamentos"));
  });
});

describe("os doze invariantes existem e vem antes da escrita", () => {
  const update = () => pos(fn, "update public.pagamentos");
  const antes = (agulha) => {
    const i = pos(fn, agulha);
    expect(i, `nao achei: ${agulha}`).toBeGreaterThan(-1);
    expect(i, `${agulha} vem depois do update`).toBeLessThan(update());
  };
  it("1. contagem igual a esperada", () => antes("linhas, esperado %"));
  it("2. pagamento_id unico na stage", () => antes("stage com pagamento_id repetido"));
  it("3. boleto unico na stage", () => antes("stage com boleto repetido"));
  it("4. nenhum campo obrigatorio vazio", () => antes("stage com campo obrigatorio vazio"));
  it("5. canonicalizacao bate com o hash", () => antes("nao confere com o artefato auditado"));
  it("6. todo pagamento_id existe", () => antes("stage referencia pagamento inexistente"));
  it("7. boleto atual = boleto esperado", () => antes("boleto do pagamento mudou desde o dry-run"));
  it("8. matricula IS NULL no alvo", () => antes("matricula ja preenchida"));
  it("9. tipo_pagamento = SANTANDER", () => antes("fora de tipo_pagamento SANTANDER"));
  it("10. boleto unico no banco", () => antes("alvo com boleto multiplo no banco"));
  it("11. ROW_COUNT igual ao previsto", () => {
    expect(fn).toMatch(/get diagnostics v_rows = row_count/);
    expect(fn).toMatch(/gravou % linhas, previsto % -- rollback total/);
  });
  it("12. toda falha e RAISE EXCEPTION, nunca aviso", () => {
    expect(fn).not.toMatch(/raise notice/i);
    expect((fn.match(/raise exception/g) || []).length).toBeGreaterThanOrEqual(12);
  });
});

describe("canonicalizacao identica a do dry-run", () => {
  it("usa os cinco campos, na ordem, separados por barra vertical", () => {
    expect(fn).toMatch(
      /s\.pagamento_id::text \|\| '\|' \|\| s\.numero_parcela_completo \|\| '\|' \|\|\s*\n?\s*s\.matricula \|\| '\|' \|\| s\.arquivo_origem \|\| '\|' \|\| s\.linha_no_arquivo::text/);
  });
  it("separa registros por newline, sem newline final (string_agg)", () => {
    expect(fn).toMatch(/E'\\n' order by s\.pagamento_id::text collate "C"/);
  });
  it('ordena com collate "C" -- sem isso a ordem muda e o hash nunca fecha', () => {
    expect(fn).toMatch(/collate "C"/);
  });
  it("compara com md5", () => expect(fn).toMatch(/md5\(string_agg\(/));
});

describe("idempotencia", () => {
  it("mesmo lote e mesmo hash devolve JA_APLICADO com zero alteracoes", () => {
    expect(fn).toMatch(/'resultado', 'JA_APLICADO'/);
    expect(fn).toMatch(/'alteracoes', 0/);
  });
  it("a saida JA_APLICADO vem antes de qualquer escrita", () => {
    expect(pos(fn, "JA_APLICADO")).toBeLessThan(pos(fn, "insert into public.backfill_matricula_lotes"));
    expect(pos(fn, "JA_APLICADO")).toBeLessThan(pos(fn, "update public.pagamentos"));
    expect(pos(fn, "JA_APLICADO")).toBeLessThan(pos(fn, "delete from public.backfill_matricula_stage"));
  });
  it("o lock do lote vem ANTES de ler o lote", () => {
    expect(pos(fn, "pg_advisory_xact_lock")).toBeGreaterThan(-1);
    expect(pos(fn, "pg_advisory_xact_lock"))
      .toBeLessThan(pos(fn, "from public.backfill_matricula_lotes where lote = p_lote"));
  });
  it("mesmo lote com hash diferente aborta", () => {
    expect(fn).toMatch(/ja existe com outro artefato/);
  });
  it("a stage so e limpa DEPOIS do update e da conferencia de row_count", () => {
    const d = pos(fn, "delete from public.backfill_matricula_stage");
    expect(d).toBeGreaterThan(pos(fn, "update public.pagamentos"));
    expect(d).toBeGreaterThan(pos(fn, "rollback total"));
  });
  it("o UPDATE carrega a guarda de matricula nula -- e ela que zera o 2o run", () => {
    const u = fn.slice(pos(fn, "update public.pagamentos"));
    const where = u.slice(u.indexOf("where"), u.indexOf("get diagnostics"));
    expect(where).toMatch(/and p\.matricula is null/);
  });
});

describe("escopo: so a matricula, e nada mais", () => {
  it("o UPDATE escreve uma unica coluna", () => {
    const u = fn.slice(pos(fn, "update public.pagamentos"));
    const set = u.slice(u.indexOf("set"), u.indexOf("from"));
    expect(set.match(/=/g)).toHaveLength(1);
    expect(set).toMatch(/matricula = s\.matricula/);
  });
  it("o UPDATE filtra pelo lote -- a stage guarda lotes falhados", () => {
    const u = fn.slice(pos(fn, "update public.pagamentos"));
    const where = u.slice(u.indexOf("where"), u.indexOf("get diagnostics"));
    expect(where).toMatch(/and s\.lote = p_lote/);
  });
  it("o UPDATE casa por id, nunca por boleto", () => {
    const u = fn.slice(pos(fn, "update public.pagamentos"));
    expect(u).toMatch(/where p\.id = s\.pagamento_id/);
    expect(u.slice(0, u.indexOf("get diagnostics"))).not.toMatch(
      /where[\s\S]*p\.numero_parcela_completo\s*=/);
  });
  it("nao chama conciliacao, acordo, parcela nem titulo", () => {
    expect(fn).not.toMatch(/conciliacao_|acordo_titulo|titulo_reavaliar|reposicao_carteira/);
    expect(fn).not.toMatch(/insert into public\.(acordos|parcelas|acordos_titulos)/);
  });
  it("nao toca em consulta_portador nem em fluxo_pagamentos_config", () => {
    expect(sqlCodigo).not.toMatch(/consulta_portador|fluxo_pagamentos_config/);
  });
  it("nao usa nada da 20260915120000", () => {
    expect(sqlCodigo).not.toMatch(/origem_liquidacao|PRIME_LIQUIDACAO_OFICIAL|TITULO_ORIGINAL_LIQUIDADO/);
  });
  it("nao faz chamada externa", () => {
    expect(sqlCodigo).not.toMatch(/net\.http_post|net\.http_get|functions\/v1/);
  });
});

describe("auditoria por lote", () => {
  it("a tabela de lotes tem os seis campos exigidos", () => {
    for (const c of ["lote", "artefato_hash", "quantidade_esperada",
                     "quantidade_aplicada", "status", "aplicado_em"]) {
      expect(sqlCodigo).toMatch(new RegExp(`${c}\\s`));
    }
  });
  it("a trilha por pagamento tem procedencia de arquivo e linha", () => {
    const t = sqlCodigo.slice(pos(sqlCodigo, "create table if not exists public.backfill_matricula_origem"));
    for (const c of ["lote", "pagamento_id", "numero_parcela_completo",
                     "matricula", "arquivo_origem", "linha_no_arquivo", "aplicado_em"]) {
      expect(t.slice(0, 900)).toMatch(new RegExp(`${c}\\s`));
    }
  });
  it("a chave admite lotes futuros sobre o mesmo pagamento", () => {
    expect(sqlCodigo).toMatch(/primary key \(lote, pagamento_id\)/);
  });
  it("a trilha e escrita na mesma transacao do update", () => {
    expect(pos(fn, "insert into public.backfill_matricula_origem"))
      .toBeLessThan(pos(fn, "update public.pagamentos"));
  });
});

describe("rollback", () => {
  it("existe e derruba funcao e tabelas", () => {
    expect(existsSync(RB)).toBe(true);
    expect(rb).toMatch(
      /drop function if exists public\.backfill_matricula_aplicar\(text, text, integer\)/);
    expect(rb).toMatch(/drop table if exists public\.backfill_matricula_stage/);
    expect(rb).toMatch(/drop table if exists public\.backfill_matricula_origem/);
    expect(rb).toMatch(/drop table if exists public\.backfill_matricula_lotes/);
  });
  it("a reversao do dado e dirigida por lote e fica comentada", () => {
    expect(rb).toMatch(/--\s*update public\.pagamentos/);
    expect(rb).toMatch(/o\.lote =/);
  });
  it("nao contem dado pessoal", () => {
    expect(rb.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)).toBeNull();
  });
});

describe("a migration prova a si mesma no apply", () => {
  it("tem bloco DO de prova", () => expect(sql).toMatch(/do \$prova\$/));
  it("a prova rejeita SECURITY DEFINER", () => {
    expect(sql).toMatch(/a funcao ficou SECURITY DEFINER/);
  });
  it("a prova rejeita execucao por anon, authenticated ou service_role", () => {
    expect(sql).toMatch(/executavel por anon, authenticated ou service_role/);
  });
  it("a prova rejeita trilha legivel fora do dono", () => {
    expect(sql).toMatch(/trilha ficou legivel fora do dono/);
  });
  it("a prova confere a ACL da stage: service_role so INSERE", () => {
    expect(sql).toMatch(/service_role perdeu o INSERT na stage/);
    expect(sql).toMatch(/service_role ganhou mais que INSERT na stage/);
  });
  it("a prova impede a volta do plano como parametro", () => {
    expect(sql).toMatch(/voltou a receber o plano como parametro/);
  });
  it("a prova exige o lock do lote", () => {
    expect(sql).toMatch(/nao adquire lock do lote/);
  });
  it("a prova vem depois de tudo que ela confere", () => {
    expect(pos(sql, "do $prova$")).toBeGreaterThan(pos(sql, "revoke all on function"));
  });
});

describe("a migration nao altera nenhuma existente", () => {
  it("nao tem drop/alter de objeto de outra migration", () => {
    expect(sqlCodigo).not.toMatch(/drop function public\.(?!backfill)/);
    expect(sqlCodigo).not.toMatch(/alter table public\.pagamentos/);
    expect(sqlCodigo).not.toMatch(/drop table public\.(?!backfill)/);
  });
});

describe("estagio: onde o plano aterrissa", () => {
  it("a tabela existe com os sete campos", () => {
    const t = sqlCodigo.slice(pos(sqlCodigo, "create table if not exists public.backfill_matricula_stage"));
    for (const c of ["lote", "pagamento_id", "numero_parcela_completo", "matricula",
                     "arquivo_origem", "linha_no_arquivo", "carregado_em"]) {
      expect(t.slice(0, 700)).toMatch(new RegExp(`${c}\\s`));
    }
  });
  it("a chave impede carga duplicada do mesmo lote", () => {
    const t = sqlCodigo.slice(pos(sqlCodigo, "create table if not exists public.backfill_matricula_stage"));
    expect(t.slice(0, 900)).toMatch(/primary key \(lote, pagamento_id\)/);
  });
  it("RLS ligada e sem policy", () => {
    expect(sqlCodigo).toMatch(/alter table public\.backfill_matricula_stage enable row level security/);
    expect(sqlCodigo).not.toMatch(/create policy/i);
  });
  it("public, anon e authenticated sem acesso", () => {
    expect(sqlCodigo).toMatch(
      /revoke all on table public\.backfill_matricula_stage from public, anon, authenticated/);
  });
  it("service_role recebe INSERT, e SO INSERT", () => {
    expect(sqlCodigo).toMatch(
      /grant insert on table public\.backfill_matricula_stage to service_role/);
    expect(sqlCodigo).not.toMatch(/grant (select|update|delete|all)[^;]*backfill_matricula_stage/i);
  });
  it("a trilha nao e concedida a service_role", () => {
    expect(sqlCodigo).toMatch(
      /revoke all on table public\.backfill_matricula_lotes\s+from public, anon, authenticated, service_role/);
    expect(sqlCodigo).not.toMatch(/grant[^;]*backfill_matricula_(lotes|origem)/i);
  });
});

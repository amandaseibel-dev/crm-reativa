// E2 -- O VINCULADOR DELEGA A DECISAO FINANCEIRA E A PROVENIENCIA E GRAVADA.
// Comportamento, nao estrutura. PostgreSQL real (PGlite). NENHUM DADO REAL.
//
// O QUE ESTES TESTES PROVAM -- e o que NAO provam.
//
// A migration da E2 e um PATCH ANCORADO: ela le o corpo vivo da funcao com
// pg_get_functiondef, confere o md5 do prosrc, troca so o trecho ancorado e
// executa. Foi escrita assim porque a arvore do repositorio NAO reproduz
// producao: o ultimo arquivo que define titulo_reavaliar (20260925123852) tem
// 5.625 caracteres de corpo, e producao tem 5.903, md5
// a86ab9bf86267fbf4c273a916b072cb7. Reescrever o corpo inteiro exigiria
// retipar 15.544 e 5.903 caracteres lidos por JSON escapado.
//
// Consequencia para o teste: nao ha como instanciar em PGlite o corpo de
// producao. Entao a bancada monta DUBLES REDUZIDOS que contem os trechos
// ancorados LETRA POR LETRA -- as mesmas constantes que a migration procura --
// mais o minimo de logica em volta para o comportamento existir.
//
//   PROVAM: que a ancora casa exatamente; que a troca produz o texto esperado;
//   que a migration e idempotente; que ela FALHA FECHADO quando o md5 nao
//   bate; que o rollback devolve o corpo byte a byte; e que a logica
//   resultante decide certo em acordo ativo, quitado, cancelado, re-acordo,
//   pagamento parcial e titulo com liquidacao oficial.
//
//   NAO PROVAM: que o resto do corpo de producao -- as ~230 linhas de guardas
//   do vinculador que a E2 nao toca -- continua funcionando. Isso so e provavel
//   no ensaio com ROLLBACK contra producao, e e por isso que a migration esta
//   em aguardando_aprovacao/ com extensao .sql.pendente.
//
// A bancada substitui o md5 esperado da migration pelo md5 do duble, com
// assercao de que a substituicao aconteceu exatamente uma vez por bloco. O
// teste "falha fechado" roda a migration SEM essa substituicao, para provar a
// recusa.
//
// usuario_e_gestao, usuario_e_diretoria e parcela_viva sao DUBLES.
import { describe, it, expect, vi, afterEach } from "vitest";

// Cada teste levanta a propria instancia PGlite (2-5 s) e alguns levantam
// duas, para comparar com e sem a migration. O padrao de 5 s do vitest nao
// cabe -- e o mesmo motivo pelo qual os testes de acoes massivas deste
// projeto ja ampliam o limite.
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const MIGRATION = ler("supabase/aguardando_aprovacao/20261026210000_e2_vinculo_delega_e_proveniencia.sql.pendente");
const ROLLBACK  = ler("supabase/aguardando_aprovacao/20261026210000_e2_vinculo_delega_e_proveniencia.rollback.sql");

const MD5_PROD_VINC = "1ea3ca97f0dea404c299ae2beda50502";
const MD5_PROD_REAV = "a86ab9bf86267fbf4c273a916b072cb7";
const MD5_PROD_DESV = "ebd07b0ec54e64f9ab685928988cb9a5";

// ---------------------------------------------------------------------------
// Os trechos ancorados, letra por letra como producao os tem. Montados por
// join para nao depender de como o editor trata recuo em template literal.
// ---------------------------------------------------------------------------
const ANCORA_VINC = [
  "  -- O estado da mensalidade segue o acordo (20260902140000): acordo pago deixa",
  "  -- a mensalidade quitada; acordo ativo deixa negociada.",
  "  v_quitado := v_status_acordo = 'QUITADO'",
  "    and not exists (",
  "      select 1 from public.parcelas p",
  "       where p.acordo_id = p_acordo_id",
  "         and public.parcela_viva(p.status));",
].join("\n");

const ANCORA_REAV = [
  "  v_quitado := v_status_acordo = 'QUITADO'",
  "    and not exists (",
  "      select 1 from public.parcelas p",
  "       where p.acordo_id = v_acordo",
  "         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA','DEVOLVIDA','SUSPENSA'));",
].join("\n");

const ANCORA_DESV_AUTH =
  "  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;";
const ANCORA_DESV_DELETE =
  "  delete from public.acordo_titulo_vinculo where titulo_id = any(p_titulo_ids);";

// ---------------------------------------------------------------------------
// Os dubles. Contem as ancoras verbatim.
// ---------------------------------------------------------------------------
const DUBLE_VINC = [
  "create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)",
  "returns jsonb language plpgsql security definer set search_path to 'public' as $function$",
  "declare",
  "  v_email text := lower(coalesce(auth.email(),''));",
  "  v_status_acordo text; v_numero text; v_quitado boolean; v_aluno_acordo uuid;",
  "  v_novos uuid[]; v_n int := 0; v_ja int := 0; v_criados int := 0;",
  "begin",
  "  select upper(coalesce(status,'')), coalesce(numero_acordo::text,''), aluno_id",
  "    into v_status_acordo, v_numero, v_aluno_acordo",
  "    from public.acordos where id = p_acordo_id;",
  "",
  "  select array_agg(t.id) into v_novos from public.acordos_titulos t",
  "   where t.id = any(p_titulo_ids) and t.acordo_id is distinct from p_acordo_id;",
  "",
  ANCORA_VINC,
  "",
  "  if v_novos is not null then",
  "    if v_quitado then",
  "      update public.acordos_titulos t",
  "         set acordo_id = p_acordo_id, situacao = 'PAGO', status = 'quitada',",
  "             motivo_ajuste = coalesce(t.motivo_ajuste,'')",
  "               || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end",
  "               || 'quitada junto com o acordo ' || v_numero",
  "               || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',",
  "             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()",
  "       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;",
  "    else",
  "      update public.acordos_titulos t",
  "         set acordo_id = p_acordo_id, situacao = 'NEGOCIADO', status = 'vinculada',",
  "             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()",
  "       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;",
  "    end if;",
  "    get diagnostics v_n = row_count;",
  "  end if;",
  "",
  "  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)",
  "  select p_acordo_id, t.id, true, v_email, now()",
  "  from public.acordos_titulos t",
  "  where t.id = any(coalesce(v_novos, '{}'::uuid[]))",
  "    and t.aluno_id = v_aluno_acordo",
  "    and not exists (select 1 from public.acordo_titulo_vinculo v",
  "                     where v.titulo_id = t.id and coalesce(v.ativo,true));",
  "  get diagnostics v_criados = row_count;",
  "",
  "  return jsonb_build_object('ok', true, 'vinculados', v_n,",
  "                            'ja_estavam', v_ja,",
  "                            'vinculos_criados', v_criados,",
  "                            'acordo_id', p_acordo_id, 'status_acordo', v_status_acordo,",
  "                            'estado_titulo', case when v_quitado then 'quitada' else 'vinculada' end);",
  "end;",
  "$function$;",
].join("\n");

const DUBLE_REAV = [
  "create or replace function public.titulo_reavaliar(p_titulo uuid)",
  "returns void language plpgsql security definer set search_path to 'public' as $function$",
  "declare",
  "  v_situacao text; v_status text; v_acordo_atual uuid;",
  "  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;",
  "  v_acordo_bloqueio uuid; v_status_bloqueio text;",
  "begin",
  "  select situacao, status, acordo_id into v_situacao, v_status, v_acordo_atual",
  "    from public.acordos_titulos where id = p_titulo;",
  "  if not found then return; end if;",
  "",
  "  -- Ja paga: nada aqui reabre mensalidade quitada.",
  "  if upper(coalesce(v_situacao,'')) = 'PAGO'",
  "     or lower(coalesce(v_status,'')) in ('quitada','paga') then",
  "    return;",
  "  end if;",
  "",
  "  if upper(coalesce(v_situacao,'')) = 'CANCELADA'",
  "     or lower(coalesce(v_status,'')) in ('cancelada','devolvido') then",
  "    return;",
  "  end if;",
  "",
  "  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')",
  "    into v_acordo, v_status_acordo, v_numero",
  "    from public.acordo_titulo_vinculo v",
  "    join public.acordos a on a.id = v.acordo_id",
  "   where v.titulo_id = p_titulo",
  "     and coalesce(v.ativo, true)",
  "     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')",
  "   order by v.criado_em desc nulls last",
  "   limit 1;",
  "",
  "  if v_acordo is null and upper(coalesce(v_situacao,'')) = 'NEGOCIADO' then",
  "    select coalesce(",
  "        (select v.acordo_id from public.acordo_titulo_vinculo v",
  "          where v.titulo_id = p_titulo",
  "          order by v.criado_em desc nulls last limit 1),",
  "        v_acordo_atual)",
  "      into v_acordo_bloqueio;",
  "    if v_acordo_bloqueio is not null then",
  "      select upper(coalesce(status,'')) into v_status_bloqueio",
  "        from public.acordos where id = v_acordo_bloqueio;",
  "    end if;",
  "    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO')",
  "       and exists (",
  "         select 1",
  "           from (select v.acordo_id from public.acordo_titulo_vinculo v",
  "                  where v.titulo_id = p_titulo",
  "                 union",
  "                 select v_acordo_atual) c",
  "          where c.acordo_id is not null",
  "            and exists (select 1 from public.parcelas p",
  "                         where p.acordo_id = c.acordo_id",
  "                           and upper(coalesce(p.status,'')) = 'PAGO')) then",
  "      return;",
  "    end if;",
  "  end if;",
  "",
  "  if v_acordo is null then",
  "    update public.acordos_titulos",
  "       set situacao = 'ABERTO', status = 'em_aberto',",
  "           acordo_id = null, atualizado_em = now()",
  "     where id = p_titulo",
  "       and (coalesce(situacao,'') <> 'ABERTO'",
  "            or coalesce(status,'') <> 'em_aberto'",
  "            or acordo_id is not null);",
  "    return;",
  "  end if;",
  "",
  ANCORA_REAV,
  "",
  "  if v_quitado then",
  "    update public.acordos_titulos",
  "       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,",
  "           origem_liquidacao     = coalesce(origem_liquidacao, 'ACORDO_QUITADO'),",
  "           origem_liquidacao_ref = coalesce(origem_liquidacao_ref, v_acordo::text),",
  "           origem_liquidacao_em  = coalesce(origem_liquidacao_em, now()),",
  "           atualizado_em = now()",
  "     where id = p_titulo;",
  "  else",
  "    update public.acordos_titulos",
  "       set situacao = 'NEGOCIADO', status = 'vinculada',",
  "           acordo_id = v_acordo, atualizado_em = now()",
  "     where id = p_titulo",
  "       and (coalesce(situacao,'') <> 'NEGOCIADO'",
  "            or coalesce(status,'') <> 'vinculada'",
  "            or acordo_id is distinct from v_acordo);",
  "  end if;",
  "end;",
  "$function$;",
].join("\n");

const DUBLE_DESV = [
  "create or replace function public.desvincular_titulos_acordo(p_titulo_ids uuid[])",
  "returns jsonb language plpgsql security definer set search_path to 'public' as $function$",
  "declare",
  "  v_email text := lower(coalesce(auth.email(),''));",
  "  v_n int;",
  "begin",
  ANCORA_DESV_AUTH,
  "",
  "  update public.acordos_titulos",
  "     set acordo_id = null, situacao = 'ABERTO', status = 'em_aberto',",
  "         vinculado_em = null, vinculado_por = null, atualizado_em = now()",
  "   where id = any(p_titulo_ids);",
  "  get diagnostics v_n = row_count;",
  "",
  ANCORA_DESV_DELETE,
  "",
  "  return jsonb_build_object('ok', true, 'desvinculados', v_n);",
  "end;",
  "$function$;",
].join("\n");

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

// prosrc e o corpo entre os delimitadores, exatamente como o Postgres guarda.
function corpoDe(duble) {
  const i = duble.indexOf("$function$");
  const j = duble.lastIndexOf("$function$");
  return duble.slice(i + "$function$".length, j);
}

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

// Troca os md5 de producao pelos md5 dos dubles, conferindo que cada troca
// aconteceu. Sem isto a migration recusaria a bancada -- que e exatamente o
// que o teste "falha fechado" prova.
// Troca APENAS a constante entre apostrofos (v_md5_esperado), nao a mencao do
// md5 no comentario de cabecalho -- que existe de proposito, para quem le o
// arquivo saber contra qual corpo ele foi escrito.
function trocaMd5(sql, de, para, ondeChamou) {
  const alvo = "'" + de + "'";
  const n = sql.split(alvo).length - 1;
  if (n !== 1) {
    throw new Error(ondeChamou + ": " + alvo + " aparece " + n + " vezes, esperava 1");
  }
  return sql.replace(alvo, "'" + para + "'");
}

function paraBancada(sql, ondeChamou) {
  sql = trocaMd5(sql, MD5_PROD_VINC, md5(corpoDe(DUBLE_VINC)), ondeChamou);
  sql = trocaMd5(sql, MD5_PROD_REAV, md5(corpoDe(DUBLE_REAV)), ondeChamou);
  // desvincular_titulos_acordo NAO entra: o bloco 4 saiu da E2 (a contencao e da
  // #757, ja na main), entao a migration nao carrega mais o md5 dela.
  return sql;
}

const migrationParaBancada = () => paraBancada(MIGRATION, "migration");
const rollbackParaBancada  = () => paraBancada(ROLLBACK, "rollback");

// Cada teste abre o seu PGlite e NINGUEM fechava: a suite deixava uma instancia
// WASM viva por teste. Isso tornava o arquivo intermitente -- rodando sozinho o
// teste do re-acordo passa sempre, na suite inteira reprovava em 2 de 3 rodadas
// (e levava o teste do rollback com ele). Fechar no afterEach e o conserto;
// ver a licao `teste-com-horario-renderizado-quebra-no-ci`: suite que oscila
// nao prova nada e derruba o CI por motivo que ninguem consegue reproduzir.
const bancosAbertos = [];

afterEach(async () => {
  await Promise.all(bancosAbertos.map((db) => db.close().catch(() => {})));
  bancosAbertos.length = 0;
});

async function novoBanco({ aplicarE2 = true } = {}) {
  const db = new PGlite();
  bancosAbertos.push(db);
  await db.exec([
    "create role anon; create role authenticated; create role service_role;",
    "create schema auth;",
    "create function auth.email() returns text language sql stable as",
    "  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'email' $$;",
    "",
    "create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,",
    "  status text default 'ATIVO', valor_total numeric, numero_acordo bigint,",
    "  criado_em timestamptz default now(), atualizado_em timestamptz default now());",
    "",
    "create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,",
    "  documento text, valor_original numeric, valor_cobranca_ajustado numeric,",
    "  situacao text, status text, acordo_id uuid, motivo_ajuste text,",
    "  origem_liquidacao text, origem_liquidacao_ref text, origem_liquidacao_em timestamptz,",
    "  vinculado_em timestamptz, vinculado_por text, atualizado_em timestamptz default now());",
    "",
    "create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),",
    "  acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text,",
    "  criado_em timestamptz default clock_timestamp());",
    "",
    "create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,",
    "  status text default 'A_VENCER', valor numeric);",
    "",
    "-- DUBLES do portao de gestao: o e-mail da allowlist do projeto.",
    "create function public.usuario_e_gestao() returns boolean language sql stable as",
    "  $$ select lower(coalesce(auth.email(),'')) in ('gestao@teste','amanda.seibel@aelbra.com.br') $$;",
    "create function public.usuario_e_diretoria() returns boolean language sql stable as",
    "  $$ select lower(coalesce(auth.email(),'')) = 'diretoria@teste' $$;",
    "create function public.parcela_viva(p_status text) returns boolean language sql immutable as",
    "  $$ select upper(coalesce(p_status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA','DEVOLVIDA','SUSPENSA') $$;",
  ].join("\n"));

  await db.exec(DUBLE_VINC);
  await db.exec(DUBLE_REAV);
  await db.exec(DUBLE_DESV);

  // O gatilho real: o insert do vinculo chama o motor.
  await db.exec([
    "create function public.titulo_situacao_por_vinculo() returns trigger language plpgsql as $$",
    "declare v_titulo uuid;",
    "begin",
    "  foreach v_titulo in array",
    "    array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)",
    "  loop",
    "    perform public.titulo_reavaliar(v_titulo);",
    "  end loop;",
    "  return coalesce(new, old);",
    "end $$;",
    "create trigger trg_titulo_situacao_por_vinculo after insert or delete or update",
    "  on public.acordo_titulo_vinculo for each row execute function titulo_situacao_por_vinculo();",
  ].join("\n"));

  if (aplicarE2) await db.exec(migrationParaBancada());
  return db;
}

async function bancada(db, { statusAcordo = "QUITADO", teto = 3313.09, mensalidades = [2869.73], parcelas = [{ status: "PAGO" }] } = {}) {
  const aluno = await um(db, "select gen_random_uuid()");
  const acordo = await um(db,
    "insert into public.acordos (aluno_id, status, valor_total, numero_acordo) values ($1,$2,$3,5696) returning id",
    [aluno, statusAcordo, teto]);
  for (const p of parcelas) {
    await db.query("insert into public.parcelas (acordo_id, status, valor) values ($1,$2,$3)",
      [acordo, p.status, p.valor ?? teto]);
  }
  const titulos = [];
  for (let i = 0; i < mensalidades.length; i++) {
    titulos.push(await um(db,
      "insert into public.acordos_titulos (aluno_id, documento, valor_original, situacao, status) values ($1,$2,$3,'ABERTO','em_aberto') returning id",
      [aluno, "451092" + (9 + i), mensalidades[i]]));
  }
  return { aluno, acordo, titulos };
}

const comoGestao = (db) => db.exec("set request.jwt.claims = '{\"email\":\"gestao@teste\"}'");

async function titulo(db, id) {
  const r = await db.query(
    "select situacao, status, acordo_id, origem_liquidacao, origem_liquidacao_ref from public.acordos_titulos where id = $1", [id]);
  return r.rows[0];
}

// ===========================================================================
describe("E2 bloco 1 -- a cobertura, em codigo novo", () => {
  it("acordo cujo teto cobre a unica mensalidade: coberto", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73] });
    await db.query("insert into public.acordo_titulo_vinculo (acordo_id, titulo_id) values ($1,$2)", [acordo, titulos[0]]);
    const d = await um(db, "select public.acordo_cobertura_detalhe($1)", [acordo]);
    expect(d.coberto).toBe(true);
    expect(Number(d.soma_titulos)).toBeCloseTo(2869.73, 2);
    expect(Number(d.descoberto)).toBeCloseTo(0, 2);
  });

  it("FORMA DA RAYSSA: teto de 3.313,09 com duas mensalidades de 2.869,73 nao cobre", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73, 2869.73] });
    for (const t of titulos) {
      await db.query("insert into public.acordo_titulo_vinculo (acordo_id, titulo_id) values ($1,$2)", [acordo, t]);
    }
    const d = await um(db, "select public.acordo_cobertura_detalhe($1)", [acordo]);
    expect(d.coberto).toBe(false);
    expect(Number(d.soma_titulos)).toBeCloseTo(5739.46, 2);
    expect(Number(d.descoberto)).toBeCloseTo(2426.37, 2);
  });

  it("acordo sem nenhum titulo vinculado NAO esta coberto -- nao ha o que comprovar", async () => {
    const db = await novoBanco();
    const { acordo } = await bancada(db);
    const d = await um(db, "select public.acordo_cobertura_detalhe($1)", [acordo]);
    expect(d.titulos_ativos).toBe(0);
    expect(d.coberto).toBe(false);
    expect(await um(db, "select public.acordo_cobertura_comprovada($1)", [acordo])).toBe(false);
  });

  it("vinculo inativo nao entra na soma", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73, 2869.73] });
    await db.query("insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo) values ($1,$2,true)", [acordo, titulos[0]]);
    await db.query("insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo) values ($1,$2,false)", [acordo, titulos[1]]);
    const d = await um(db, "select public.acordo_cobertura_detalhe($1)", [acordo]);
    expect(d.titulos_ativos).toBe(1);
    expect(d.coberto).toBe(true);
  });

  it("valor_cobranca_ajustado prevalece sobre valor_original", async () => {
    const db = await novoBanco();
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73, 2869.73] });
    for (const t of titulos) {
      await db.query("insert into public.acordo_titulo_vinculo (acordo_id, titulo_id) values ($1,$2)", [acordo, t]);
    }
    await db.query("update public.acordos_titulos set valor_cobranca_ajustado = 200 where id = any($1)", [titulos]);
    const d = await um(db, "select public.acordo_cobertura_detalhe($1)", [acordo]);
    expect(Number(d.soma_titulos)).toBeCloseTo(400, 2);
    expect(d.coberto).toBe(true);
  });

  it("acordo inexistente: existe=false e coberto=false, sem erro", async () => {
    const db = await novoBanco();
    const d = await um(db, "select public.acordo_cobertura_detalhe(gen_random_uuid())");
    expect(d.existe).toBe(false);
    expect(d.coberto).toBe(false);
  });
});

// ===========================================================================
describe("E2 blocos 2 e 3 -- o vinculador delega e a proveniencia aparece", () => {
  it("acordo QUITADO COM cobertura: titulo sai PAGO E COM proveniencia", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73] });
    await um(db, "select public.vincular_titulos_acordo($1,$2)", [titulos, acordo]);
    const t = await titulo(db, titulos[0]);
    expect(t.situacao).toBe("PAGO");
    expect(t.status).toBe("quitada");
    expect(t.origem_liquidacao).toBe("ACORDO_QUITADO");
    expect(t.origem_liquidacao_ref).toBe(acordo);
  });

  it("FORMA DA RAYSSA: acordo QUITADO SEM cobertura deixa as duas NEGOCIADO, nenhuma PAGO", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73, 2869.73] });
    await um(db, "select public.vincular_titulos_acordo($1,$2)", [titulos, acordo]);
    for (const id of titulos) {
      const t = await titulo(db, id);
      expect(t.situacao).toBe("NEGOCIADO");
      expect(t.status).toBe("vinculada");
      expect(t.origem_liquidacao).toBeNull();
    }
    const d = await um(db, "select public.acordo_cobertura_detalhe($1)", [acordo]);
    expect(Number(d.descoberto)).toBeCloseTo(2426.37, 2);
  });

  it("MUTACAO -- SEM A E2 a mesma bancada quita as duas SEM proveniencia (o defeito existe)", async () => {
    const db = await novoBanco({ aplicarE2: false });
    await comoGestao(db);
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73, 2869.73] });
    await um(db, "select public.vincular_titulos_acordo($1,$2)", [titulos, acordo]);
    for (const id of titulos) {
      const t = await titulo(db, id);
      expect(t.situacao).toBe("PAGO");
      expect(t.origem_liquidacao).toBeNull();
    }
  });

  it("acordo ATIVO: NEGOCIADO, como sempre foi", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    const { acordo, titulos } = await bancada(db, { statusAcordo: "ATIVO", mensalidades: [2869.73], parcelas: [{ status: "A_VENCER" }] });
    await um(db, "select public.vincular_titulos_acordo($1,$2)", [titulos, acordo]);
    const t = await titulo(db, titulos[0]);
    expect(t.situacao).toBe("NEGOCIADO");
    expect(t.origem_liquidacao).toBeNull();
  });

  it("acordo marcado QUITADO com parcela viva nao quita nada -- guarda de 20260831140000 preservada", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    const { acordo, titulos } = await bancada(db, { statusAcordo: "QUITADO", mensalidades: [2869.73], parcelas: [{ status: "A_VENCER" }] });
    await um(db, "select public.vincular_titulos_acordo($1,$2)", [titulos, acordo]);
    expect((await titulo(db, titulos[0])).situacao).toBe("NEGOCIADO");
  });

  it("PAGAMENTO PARCIAL: uma parcela PAGO e outra A_VENCER nao quita", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    const { acordo, titulos } = await bancada(db, {
      statusAcordo: "QUITADO", mensalidades: [2869.73],
      parcelas: [{ status: "PAGO", valor: 1656 }, { status: "A_VENCER", valor: 1657 }],
    });
    await um(db, "select public.vincular_titulos_acordo($1,$2)", [titulos, acordo]);
    expect((await titulo(db, titulos[0])).situacao).toBe("NEGOCIADO");
  });

  it("TITULO COM LIQUIDACAO OFICIAL ja PAGO: o motor retorna na guarda e nao mexe", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    const { acordo, titulos } = await bancada(db, { teto: 1, mensalidades: [2869.73] });
    await db.query([
      "update public.acordos_titulos set situacao='PAGO', status='quitada',",
      "  origem_liquidacao='PRIME_LIQUIDACAO_OFICIAL', origem_liquidacao_ref='prime' where id=$1",
    ].join("\n"), [titulos[0]]);
    await db.query("insert into public.acordo_titulo_vinculo (acordo_id, titulo_id) values ($1,$2)", [acordo, titulos[0]]);
    const t = await titulo(db, titulos[0]);
    expect(t.situacao).toBe("PAGO");
    expect(t.origem_liquidacao).toBe("PRIME_LIQUIDACAO_OFICIAL");
  });

  // A guarda de re-acordo (22/09/2026) nao e tocada pela E2, e este teste prova
  // isso rodando a MESMA bancada com e sem a migration: as duas tem de dar o
  // mesmo resultado.
  //
  // A bancada desliga o gatilho enquanto monta. Com ele ligado, o primeiro
  // insert de vinculo ja chamaria o motor: naquele instante o unico vinculo e o
  // do acordo A, que esta QUITADO -- nao entra na lista de status que a guarda
  // vigia -- e o titulo cairia para ABERTO antes de o vinculo de B existir. O
  // estado que a producao produz e o de DEPOIS dos dois vinculos.
  async function bancadaReacordo(db) {
    await db.exec("alter table public.acordo_titulo_vinculo disable trigger trg_titulo_situacao_por_vinculo");
    const aluno = await um(db, "select gen_random_uuid()");
    const a = await um(db, "insert into public.acordos (aluno_id,status,valor_total,numero_acordo) values ($1,'QUITADO',3000,1) returning id", [aluno]);
    const b = await um(db, "insert into public.acordos (aluno_id,status,valor_total,numero_acordo) values ($1,'CANCELADO',3000,2) returning id", [aluno]);
    await db.query("insert into public.parcelas (acordo_id,status,valor) values ($1,'PAGO',3000)", [a]);
    const t = await um(db,
      "insert into public.acordos_titulos (aluno_id,documento,valor_original,situacao,status,acordo_id) values ($1,'1',2000,'NEGOCIADO','vinculada',$2) returning id",
      [aluno, b]);
    // criado_em EXPLICITO e distinto, e nao e detalhe de arrumacao: a guarda de
    // 20260925123852 escolhe o acordo da cadeia com
    // `order by v.criado_em desc nulls last limit 1`. Com os dois vinculos
    // nascendo no mesmo now() o desempate fica indefinido e a suite virava cara
    // ou coroa: as vezes a guarda pegava B (CANCELADO -- o caminho certo, que
    // ve dinheiro na cadeia via A e mantem NEGOCIADO), as vezes A (QUITADO, que
    // nao esta na lista de status vigiados, cai no "sem acordo vivo, reabre" e
    // devolve ABERTO). A ordem real do re-acordo e A antes de B, entao B e o
    // mais recente -- e e isso que a bancada passa a dizer, sem empate.
    await db.query("insert into public.acordo_titulo_vinculo (acordo_id,titulo_id,ativo,criado_em) values ($1,$2,false,now() - interval '30 days')", [a, t]);
    await db.query("insert into public.acordo_titulo_vinculo (acordo_id,titulo_id,ativo,criado_em) values ($1,$2,true,now())", [b, t]);
    await db.exec("alter table public.acordo_titulo_vinculo enable trigger trg_titulo_situacao_por_vinculo");
    return t;
  }

  it("RE-ACORDO: A pago em parte, B cancelado sem pagar -- B nao reabre a mensalidade", async () => {
    const db = await novoBanco();
    await comoGestao(db);
    const t = await bancadaReacordo(db);
    await um(db, "select public.titulo_reavaliar($1)", [t]);
    expect((await titulo(db, t)).situacao).toBe("NEGOCIADO");
  });

  it("RE-ACORDO: a E2 nao muda o resultado -- com e sem a migration dao o mesmo", async () => {
    const comE2 = await novoBanco();
    await comoGestao(comE2);
    const t1 = await bancadaReacordo(comE2);
    await um(comE2, "select public.titulo_reavaliar($1)", [t1]);

    const semE2 = await novoBanco({ aplicarE2: false });
    await comoGestao(semE2);
    const t2 = await bancadaReacordo(semE2);
    await um(semE2, "select public.titulo_reavaliar($1)", [t2]);

    expect((await titulo(comE2, t1)).situacao).toBe((await titulo(semE2, t2)).situacao);
  });
});

// ===========================================================================
describe("E2 nao toca desvincular_titulos_acordo (a contencao e da #757)", () => {
  it("o corpo de desvincular fica byte a byte igual depois da E2", async () => {
    const db = await novoBanco();
    expect(await um(db, "select md5(prosrc) from pg_proc where proname='desvincular_titulos_acordo'")).toBe(md5(corpoDe(DUBLE_DESV)));
  });

  it("nem a migration nem o rollback carregam o md5 de desvincular", () => {
    expect(MIGRATION).not.toContain("'" + MD5_PROD_DESV + "'");
    expect(ROLLBACK).not.toContain("'" + MD5_PROD_DESV + "'");
  });

  it("a E2 nao deixa marca de contencao nenhuma no corpo de desvincular", async () => {
    const db = await novoBanco();
    const def = await um(db, "select pg_get_functiondef(oid) from pg_proc where proname='desvincular_titulos_acordo'");
    expect(def).not.toContain("SEM_PERMISSAO_GESTAO");
    expect(def).not.toContain("TITULO_COM_LASTRO");
  });
});

// ===========================================================================
describe("E2 -- a migration como mecanismo", () => {
  it("idempotente: aplicar duas vezes nao muda o corpo", async () => {
    const db = await novoBanco();
    const antes = await um(db, "select md5(prosrc) from pg_proc where proname='titulo_reavaliar'");
    await db.exec(migrationParaBancada());
    const depois = await um(db, "select md5(prosrc) from pg_proc where proname='titulo_reavaliar'");
    expect(depois).toBe(antes);
  });

  it("FALHA FECHADO: com o md5 de producao sobre um corpo diferente, recusa", async () => {
    const db = await novoBanco({ aplicarE2: false });
    await expect(db.exec(MIGRATION)).rejects.toThrow(/md5 do corpo/);
  });

  it("FALHA FECHADO: ancora ausente aborta", async () => {
    const db = await novoBanco({ aplicarE2: false });
    // tira a ancora do duble do motor, mantendo o md5 coerente com o que a bancada espera
    const mutilado = DUBLE_REAV.replace(ANCORA_REAV, "  v_quitado := false;");
    await db.exec(mutilado);
    let sql = trocaMd5(MIGRATION,  MD5_PROD_VINC, md5(corpoDe(DUBLE_VINC)), "ancora");
    sql     = trocaMd5(sql,        MD5_PROD_REAV, md5(corpoDe(mutilado)),   "ancora");
    await expect(db.exec(sql)).rejects.toThrow(/ancora/);
  });

  it("a guarda de PAGO continua no corpo novo -- e ela que protege os 798 titulos", async () => {
    const db = await novoBanco();
    const def = await um(db, "select pg_get_functiondef(oid) from pg_proc where proname='titulo_reavaliar'");
    expect(def).toContain("-- Ja paga: nada aqui reabre mensalidade quitada.");
    expect(def).toContain("acordo_cobertura_comprovada");
  });

  it("o vinculador nao escreve mais PAGO em lugar nenhum", async () => {
    const db = await novoBanco();
    const def = await um(db, "select pg_get_functiondef(oid) from pg_proc where proname='vincular_titulos_acordo'");
    expect(def).not.toContain("situacao = 'PAGO'");
    // a bifurcacao saiu inteira: nao sobrou ramo morto nem uso de v_quitado
    expect(def).not.toContain("if v_quitado then");
    expect(def).not.toContain("v_quitado :=");
    expect(def).toContain("E2: UM CAMINHO SO");
  });

  it("as funcoes novas nascem fechadas para anon", async () => {
    const db = await novoBanco();
    for (const f of ["acordo_cobertura_detalhe", "acordo_cobertura_comprovada"]) {
      const acl = await um(db, "select coalesce(array_to_string(proacl,','),'(nula)') from pg_proc where proname=$1", [f]);
      expect(acl).not.toContain("anon=X");
      expect(acl).toContain("authenticated=X");
    }
  });

  it("ROLLBACK devolve os tres corpos byte a byte", async () => {
    const db = await novoBanco();
    await db.exec(rollbackParaBancada());
    expect(await um(db, "select md5(prosrc) from pg_proc where proname='titulo_reavaliar'")).toBe(md5(corpoDe(DUBLE_REAV)));
    expect(await um(db, "select md5(prosrc) from pg_proc where proname='vincular_titulos_acordo'")).toBe(md5(corpoDe(DUBLE_VINC)));
    expect(await um(db, "select md5(prosrc) from pg_proc where proname='desvincular_titulos_acordo'")).toBe(md5(corpoDe(DUBLE_DESV)));
    expect(await um(db, "select count(*)::int from pg_proc where proname like 'acordo_cobertura%'")).toBe(0);
  });

  it("ZERO DML: aplicar a migration nao toca nenhuma linha de negocio", async () => {
    const db = await novoBanco({ aplicarE2: false });
    await comoGestao(db);
    // bancada com dado nos cinco lugares que importam
    const { acordo, titulos } = await bancada(db, { teto: 3313.09, mensalidades: [2869.73, 2869.73] });
    for (const x of titulos) {
      await db.query("insert into public.acordo_titulo_vinculo (acordo_id,titulo_id) values ($1,$2)", [acordo, x]);
    }
    const foto = async () => ({
      acordos: await um(db, "select count(*)::int from public.acordos"),
      titulos: await um(db, "select count(*)::int from public.acordos_titulos"),
      vinculos: await um(db, "select count(*)::int from public.acordo_titulo_vinculo"),
      parcelas: await um(db, "select count(*)::int from public.parcelas"),
      soma_titulos: await um(db, "select coalesce(sum(valor_original),0)::text from public.acordos_titulos"),
      soma_acordos: await um(db, "select coalesce(sum(valor_total),0)::text from public.acordos"),
      estados: await um(db, "select string_agg(coalesce(situacao,'-')||'/'||coalesce(status,'-'), ',' order by documento) from public.acordos_titulos"),
      vivos: await um(db, "select count(*)::int from public.acordo_titulo_vinculo where ativo"),
      proveniencia: await um(db, "select count(*)::int from public.acordos_titulos where origem_liquidacao is not null"),
    });

    const antes = await foto();
    await db.exec(migrationParaBancada());
    const depois = await foto();

    expect(depois).toEqual(antes);
  });
});

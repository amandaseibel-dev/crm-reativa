// Teste de acesso da migration 20261113120000 em Postgres local (pglite).
// Fora do repositório. Não conecta em nenhum banco real.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIG = process.argv[2];
const ROLLBACK = process.argv[3];

const AMANDA = "amanda.seibel@aelbra.com.br";
const FERNANDA = "cobranca04@aelbra.com.br";
const ADM = "cobranca07@aelbra.com.br";
const OPERADOR = "operador.teste@exemplo.local";

// Stub: reproduz o que o Supabase faz por padrão (papéis, privilégios padrão de
// schema public, auth.jwt, RLS de notificacoes) e a função de gestão conforme
// o corpo lido em produção por SELECT (pg_get_functiondef).
const STUB = `
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
-- Privilégios padrão do Supabase: tabela nova nasce com ALL para os três papéis.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.usuarios (email text primary key, ativo boolean not null default true);
insert into public.usuarios (email) values
  ('${AMANDA}'), ('${FERNANDA}'), ('${ADM}'), ('${OPERADOR}');
grant select on public.usuarios to authenticated;

create or replace function public.app_usuario_ativo() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.usuarios u
                  where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and u.ativo)
$$;

create or replace function public.usuario_e_gestao() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br', 'cobranca07@aelbra.com.br')
$$;

create table public.notificacoes (
  id uuid primary key default gen_random_uuid(),
  usuario_destino_email text not null,
  usuario_destino_nome text,
  tipo text not null,
  titulo text not null,
  mensagem text,
  aluno_id text,
  caso_id uuid, baixa_id uuid, link_pagamento_id uuid, solicitacao_link_id uuid,
  url_destino text,
  lida boolean not null default false,
  lida_em timestamptz,
  criado_em timestamptz not null default now()
);
alter table public.notificacoes enable row level security;
create policy notif_select_proprias on public.notificacoes for select to authenticated
  using (lower(usuario_destino_email) = lower(auth.jwt() ->> 'email'));
create policy notificacoes_insert on public.notificacoes for insert to authenticated
  with check (public.app_usuario_ativo() and public.usuario_e_gestao());
grant select, insert, update on public.notificacoes to authenticated;
`;

const db = new PGlite();
let falhas = 0;
const resultados = [];

function registrar(nome, ok, detalhe = "") {
  resultados.push({ nome, ok, detalhe });
  if (!ok) falhas++;
}

// Executa SQL como um papel e com um e-mail de JWT. Devolve {ok, rows, code, err}.
async function como(papel, email, sql, params = []) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify(email ? { email, role: papel || "postgres" } : {}),
  ]);
  if (papel) await db.exec(`set role ${papel}`);
  try {
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, err: e.message, code: e.code };
  } finally {
    await db.exec("reset role");
  }
}

function esperaNegado(nome, r) {
  registrar(nome, !r.ok, r.ok ? `permitiu: ${JSON.stringify(r.rows).slice(0, 120)}` : `${r.code} ${r.err}`);
}
function esperaOk(nome, r, checar = () => true) {
  const ok = r.ok && checar(r);
  registrar(nome, ok, r.ok ? "" : `${r.code} ${r.err}`);
}

async function main() {
  await db.exec(STUB);
  await db.exec(readFileSync(MIG, "utf8"));

  // ---------- Privilégios por papel (matriz direta, não por erro de função) ----------
  const priv = async (papel, objeto, tipo) => (await db.query(
    tipo === "t" ? "select has_table_privilege($1,$2,$3) as v" : "select has_function_privilege($1,$2,'EXECUTE') as v",
    tipo === "t" ? [papel, objeto, "SELECT"] : [papel, objeto])).rows[0].v;
  const T = "public.aluno_termo_fisico_eventos";
  const L = "public.termo_fisico_ler(text)";
  const R = "public.termo_fisico_registrar(text,text,boolean)";
  const I = "public.aluno_termo_fisico_eventos_imutavel()";
  for (const papel of ["anon", "service_role", "public"]) {
    for (const op of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      const v = (await db.query("select has_table_privilege($1,$2,$3) as v", [papel, T, op])).rows[0].v;
      registrar(`privilégio: ${papel} não tem ${op} na tabela`, v === false, `tem=${v}`);
    }
    registrar(`privilégio: ${papel} não executa termo_fisico_ler`, (await priv(papel, L, "f")) === false);
    registrar(`privilégio: ${papel} não executa termo_fisico_registrar`, (await priv(papel, R, "f")) === false);
    registrar(`privilégio: ${papel} não executa a função de trigger`, (await priv(papel, I, "f")) === false);
  }
  for (const op of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
    const v = (await db.query("select has_table_privilege($1,$2,$3) as v", ["authenticated", T, op])).rows[0].v;
    registrar(`privilégio: authenticated não tem ${op} na tabela`, v === false, `tem=${v}`);
  }
  registrar("privilégio: authenticated tem SELECT na tabela (RLS restringe)", (await db.query("select has_table_privilege('authenticated',$1,'SELECT') as v", [T])).rows[0].v === true);
  registrar("privilégio: authenticated executa as duas RPCs", (await priv("authenticated", L, "f")) && (await priv("authenticated", R, "f")));

  // ---------- Operador e anônimo: nada do registro ----------
  esperaNegado("anon: lê a tabela", await como("anon", "", "select * from public.aluno_termo_fisico_eventos"));
  esperaNegado("anon: executa termo_fisico_ler", await como("anon", "", "select public.termo_fisico_ler('1')"));
  esperaNegado("anon: executa termo_fisico_registrar", await como("anon", "", "select public.termo_fisico_registrar('1','ARQUIVADO',false)"));

  // Antes de tudo, um registro feito pela gestão para o operador tentar ver.
  esperaOk("gestão (Amanda): registra em andamento, com aviso",
    await como("authenticated", AMANDA, "select public.termo_fisico_registrar('42','EM_ANDAMENTO',true)"));

  const leituraDireta = await como("authenticated", OPERADOR, "select * from public.aluno_termo_fisico_eventos");
  registrar("operador: lê a tabela direto e não vê nenhuma linha (RLS)", leituraDireta.ok && leituraDireta.rows.length === 0,
    leituraDireta.ok ? `vê ${leituraDireta.rows.length}` : `${leituraDireta.code} ${leituraDireta.err}`);
  esperaNegado("operador: executa termo_fisico_ler", await como("authenticated", OPERADOR, "select public.termo_fisico_ler('42')"));
  esperaNegado("operador: executa termo_fisico_registrar", await como("authenticated", OPERADOR, "select public.termo_fisico_registrar('42','ARQUIVADO',false)"));
  esperaNegado("operador: insere direto na tabela", await como("authenticated", OPERADOR, "insert into public.aluno_termo_fisico_eventos (aluno_id, situacao, autor_email) values ('42','ARQUIVADO','x@y')"));
  esperaNegado("operador: atualiza direto", await como("authenticated", OPERADOR, "update public.aluno_termo_fisico_eventos set situacao='ARQUIVADO'"));
  esperaNegado("operador: apaga direto", await como("authenticated", OPERADOR, "delete from public.aluno_termo_fisico_eventos"));
  esperaNegado("operador: TRUNCATE", await como("authenticated", OPERADOR, "truncate public.aluno_termo_fisico_eventos"));

  const notifOperador = await como("authenticated", OPERADOR, "select id from public.notificacoes where tipo = 'TERMO_FISICO'");
  registrar("operador: não recebe notificação de termo físico",
    notifOperador.ok && notifOperador.rows.length === 0,
    notifOperador.ok ? `vê ${notifOperador.rows.length}` : `${notifOperador.code} ${notifOperador.err}`);

  // ---------- Gestão: leitura, registro e aviso ----------
  esperaOk("gestão (Amanda): lê situação e histórico", await como("authenticated", AMANDA, "select public.termo_fisico_ler('42') as r"),
    (r) => r.rows[0].r.situacao === "EM_ANDAMENTO" && r.rows[0].r.eventos.length === 1 && r.rows[0].r.eventos[0].autor_email === AMANDA);

  esperaOk("ADM (cobranca07): registra arquivado, com aviso",
    await como("authenticated", ADM, "select public.termo_fisico_registrar('42','ARQUIVADO',true)"));
  esperaOk("ADM: lê, vê histórico com 2 registros",
    await como("authenticated", ADM, "select public.termo_fisico_ler('42') as r"),
    (r) => r.rows[0].r.situacao === "ARQUIVADO" && r.rows[0].r.eventos.length === 2);

  esperaNegado("gestão: situação inválida é recusada", await como("authenticated", AMANDA, "select public.termo_fisico_registrar('42','QUITADO',false)"));
  esperaNegado("gestão: aluno vazio é recusado", await como("authenticated", AMANDA, "select public.termo_fisico_registrar('  ','ARQUIVADO',false)"));

  // Avisos: o da ADM vai para Amanda e Fernanda, não para a própria ADM.
  const avisos = await db.query("select usuario_destino_email from public.notificacoes where tipo='TERMO_FISICO' order by usuario_destino_email");
  const dest = avisos.rows.map((r) => r.usuario_destino_email).sort();
  // Registro da Amanda avisa ADM + Fernanda; registro da ADM avisa Amanda + Fernanda.
  const esperado = [AMANDA, FERNANDA, FERNANDA, ADM].sort();
  registrar("aviso: cada registro avisa os outros dois, nunca o próprio autor",
    JSON.stringify(dest) === JSON.stringify(esperado),
    JSON.stringify(dest));

  const notifFernanda = await como("authenticated", FERNANDA, "select id from public.notificacoes where tipo = 'TERMO_FISICO'");
  registrar("Fernanda lê o próprio aviso", notifFernanda.ok && notifFernanda.rows.length >= 1,
    notifFernanda.ok ? `${notifFernanda.rows.length}` : `${notifFernanda.code} ${notifFernanda.err}`);

  // ---------- Operador conhece a tabela de avisos? Não recebe nenhum ----------
  const notifOperador2 = await como("authenticated", OPERADOR, "select id from public.notificacoes where tipo = 'TERMO_FISICO'");
  registrar("operador: continua sem aviso de termo físico", notifOperador2.ok && notifOperador2.rows.length === 0);

  // ---------- Service role e dono: sem acesso direto à tabela ----------
  esperaNegado("service_role: lê a tabela direto", await como("service_role", "", "select * from public.aluno_termo_fisico_eventos"));
  esperaNegado("service_role: insere direto", await como("service_role", "", "insert into public.aluno_termo_fisico_eventos (aluno_id, situacao, autor_email) values ('1','ARQUIVADO','x@y')"));
  esperaNegado("service_role: TRUNCATE", await como("service_role", "", "truncate public.aluno_termo_fisico_eventos"));
  esperaNegado("service_role: executa termo_fisico_registrar", await como("service_role", "", "select public.termo_fisico_registrar('1','ARQUIVADO',false)"));
  esperaNegado("service_role: executa termo_fisico_ler", await como("service_role", "", "select public.termo_fisico_ler('1')"));
  esperaNegado("authenticated: TRUNCATE direto", await como("authenticated", AMANDA, "truncate public.aluno_termo_fisico_eventos"));

  // Dono (postgres): UPDATE, DELETE e TRUNCATE são bloqueados pelas triggers.
  for (const [nome, sql] of [
    ["dono: UPDATE bloqueado por trigger", "update public.aluno_termo_fisico_eventos set situacao='ARQUIVADO'"],
    ["dono: DELETE bloqueado por trigger", "delete from public.aluno_termo_fisico_eventos"],
    ["dono: TRUNCATE bloqueado por trigger", "truncate public.aluno_termo_fisico_eventos"],
  ]) {
    const r = await como(null, "", sql);
    registrar(nome, !r.ok && /append-only/.test(r.err), r.ok ? "executou" : r.err);
  }
  const conta = await db.query("select count(*)::int as n from public.aluno_termo_fisico_eventos");
  registrar("histórico intacto após as tentativas de alteração", conta.rows[0].n === 2, `n=${conta.rows[0].n}`);

  // ---------- Rollback ----------
  if (ROLLBACK) {
    await db.exec(readFileSync(ROLLBACK, "utf8"));
    esperaNegado("rollback: tabela renomeada não é lida por authenticated",
      await como("authenticated", AMANDA, "select * from public.aluno_termo_fisico_eventos_descartada_20261113"));
    esperaNegado("rollback: nem a gestão lê a tabela descartada",
      await como("authenticated", AMANDA, "select * from public.aluno_termo_fisico_eventos_descartada_20261113"));
    esperaNegado("rollback: RPC de leitura removida", await como("authenticated", AMANDA, "select public.termo_fisico_ler('42')"));
    const hist = await db.query("select count(*)::int as n from public.aluno_termo_fisico_eventos_descartada_20261113");
    registrar("rollback: histórico preservado", hist.rows[0].n === 2, `n=${hist.rows[0].n}`);
    const upd = await como(null, "", "update public.aluno_termo_fisico_eventos_descartada_20261113 set situacao='ARQUIVADO'");
    registrar("rollback: tabela renomeada continua imutável", !upd.ok && /append-only/.test(upd.err), upd.ok ? "executou" : upd.err);

    // Reinstalação: reaplica a migration e copia sem duplicar.
    await db.exec(readFileSync(MIG, "utf8"));
    await db.exec(`insert into public.aluno_termo_fisico_eventos
                   select * from public.aluno_termo_fisico_eventos_descartada_20261113
                   on conflict (id) do nothing`);
    const nova = await db.query("select count(*)::int as n from public.aluno_termo_fisico_eventos");
    const velha = await db.query("select count(*)::int as n from public.aluno_termo_fisico_eventos_descartada_20261113");
    registrar("reinstalação: contagem igual à descartada, sem duplicar",
      nova.rows[0].n === velha.rows[0].n && nova.rows[0].n === 2,
      `nova=${nova.rows[0].n} descartada=${velha.rows[0].n}`);
  }

  for (const r of resultados) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.nome}${r.detalhe && !r.ok ? "  -> " + r.detalhe : ""}`);
  console.log(`\n${resultados.length - falhas}/${resultados.length} passaram`);
  process.exitCode = falhas ? 1 : 0;
}

main().catch((e) => {
  console.error("ERRO NO HARNESS:", e);
  process.exitCode = 2;
});

// D5 em Postgres real: duas conexoes, intercalamento controlado.
// A: recalcular_situacao_aluno, pausada dentro (calibragem), depois da leitura inicial.
// B: agenda_reagendar_retorno, commit enquanto A esta pausada.
// Uso: node d5_repro.cjs <raiz-do-repo> <porta> <sem_correcao|for_update>
const fs = require("fs");
const { Client } = require("pg");
const RAIZ = process.argv[2];
const PORTA = Number(process.argv[3] || 57017);
const MODO = process.argv[4] || "sem_correcao";
const ler = (p) => fs.readFileSync(RAIZ + "/" + p, "utf8");

const testSrc = ler("supabase/tests/reagendamento_explicito_comportamento.test.js");
let esquema = testSrc.slice(testSrc.indexOf("const ESQUEMA = `") + "const ESQUEMA = `".length);
esquema = esquema.slice(0, esquema.indexOf("`;"));
esquema = esquema.replace("  create role anon;\n  create role authenticated;\n", () => "");
esquema = esquema.replace("${GESTAO.join(\"','\")}", () => "amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br");
const CAL_ORIG = "create function public.calibragem_nivel_criticidade(int, int, numeric, boolean, boolean, jsonb)\n    returns text language sql as $$ select 'ATENCAO'::text $$;";
const CAL_NOVA = "create function public.calibragem_nivel_criticidade(int, int, numeric, boolean, boolean, jsonb)\n    returns text language plpgsql as $c$ begin if coalesce(current_setting('teste.pausa', true), '') = '1' then perform pg_sleep(1.5); end if; return 'ATENCAO'; end $c$;";
if (esquema.split(CAL_ORIG).length !== 2) throw new Error("ancora da calibragem nao bate");
esquema = esquema.split(CAL_ORIG).join(CAL_NOVA);

const CORPO = ler("supabase/tests/fixtures/recalcular_situacao_aluno_prod_20261113.sql");
const P1 = ler("supabase/aguardando_aprovacao/20261113120000_retorno_tratado_nao_herda_selo_do_operador.sql.pendente");
const AGENDA = ler("supabase/migrations/20260808150000_agenda_retorno_confirmado.sql");
const P2 = ler("supabase/aguardando_aprovacao/20261114120000_agenda_reagendar_retorno_e_portao_recalculo.sql.pendente");

const OP = "operador.teste@exemplo.local";
const ALUNA = "a1000000-0000-4000-8000-000000000001";
const UID = "00000000-0000-4000-8000-0000000000a1";
const BANCO = "d5_repro_" + MODO;
const DIRETO = MODO === "pacote";

async function conectar(banco) {
  const c = new Client({ host: "127.0.0.1", port: PORTA, user: "postgres", database: banco });
  await c.connect();
  return c;
}

(async () => {
  const admin = await conectar("postgres");
  await admin.query(`drop database if exists ${BANCO}`);
  await admin.query(`create database ${BANCO}`);
  await admin.end();

  const a = await conectar(BANCO);
  const b = await conectar(BANCO);
  const s = await conectar(BANCO);

  await s.query("do $r$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; end $r$");
  for (const [nome, sql] of [["esquema", esquema], ["agenda", AGENDA], ["corpo", CORPO], ["p1", P1], ["p2", P2]]) {
    try {
      await s.query(sql);
    } catch (e) {
      throw new Error(nome + ": " + e.message);
    }
  }
  if (MODO === "sem_correcao") {
    await s.query(`do $lockr$
declare
  v_assin constant text := 'public.recalcular_situacao_aluno(uuid,text)';
  v_ancora constant text := $a$from public.alunos where id=p_aluno_id for update;$a$;
  v_troca constant text := $n$from public.alunos where id=p_aluno_id;$n$;
  v_oid oid := to_regprocedure(v_assin);
  v_def text; v_nova text; v_md5_antes text; v_md5_depois text;
  v_guarda_antes text; v_guarda_depois text; v_n int;
begin
  if v_oid is null then raise exception 'FUNCAO AUSENTE: %', v_assin; end if;
  v_def := pg_get_functiondef(v_oid);
  select md5(p.prosrc),
         concat_ws('|', p.proowner::text, p.prosecdef::text, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    into v_md5_antes, v_guarda_antes from pg_proc p where p.oid = v_oid;
  if v_md5_antes = '03dacc0abb23490a8e060c4f86e0df94' then
    raise notice 'rollback leitura travada: ja sem o lock, nada a reverter.';
    return;
  end if;
  if v_md5_antes <> 'c3e38ac06719b886297369e1f0e507aa' then
    raise exception 'CORPO INESPERADO no rollback: md5 %, esperado c3e38ac0.', v_md5_antes;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then raise exception 'ANCORA NAO BATE no rollback: %', v_n; end if;
  v_nova := replace(v_def, v_ancora, v_troca);
  execute v_nova;
  select md5(p.prosrc),
         concat_ws('|', p.proowner::text, p.prosecdef::text, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    into v_md5_depois, v_guarda_depois from pg_proc p where p.oid = v_oid;
  if v_guarda_depois is distinct from v_guarda_antes then raise exception 'DONO/DEFINER/CONFIG/ACL mudaram no rollback'; end if;
  if v_md5_depois <> '03dacc0abb23490a8e060c4f86e0df94' then
    raise exception 'RESULTADO INESPERADO no rollback: md5 %, previsto 03dacc0a', v_md5_depois;
  end if;
end $lockr$;`);
  }
  if (MODO === "for_update") {  // correcao candidata (ja incorporada ao pacote em MODO=pacote)
    const r = await s.query("select pg_get_functiondef('public.recalcular_situacao_aluno(uuid,text)'::regprocedure) as d");
    const alvo = "from public.alunos where id=p_aluno_id;";
    const src = r.rows[0].d;
    if (src.split(alvo).length !== 2) throw new Error("ancora FOR UPDATE nao unica");
    await s.query(src.split(alvo).join("from public.alunos where id=p_aluno_id for update;"));
  }

  await s.query("insert into public.usuarios (email, ativo) values ($1, true)", [OP]);
  await s.query("insert into public.alunos (id, nome, responsavel_atual_email, data_ultimo_acionamento, observacao) values ($1, 'Aluna Ficticia', $2, now() - interval '3 days', 'obs')", [ALUNA, OP]);
  await s.query("insert into public.casos (aluno_id) values ($1)", [ALUNA]);
  await s.query("insert into public.acordos_titulos (aluno_id, situacao, status, tipo_boleto, vencimento, valor_original) values ($1, 'ABERTO', 'aberta', 'Mensalidade', current_date - 40, 500)", [ALUNA]);
  await s.query("select public.recalcular_situacao_aluno($1, 'preparo')", [ALUNA]);
  await s.query("update public.alunos set data_retorno = current_date, hora_retorno = '10:00', retorno_origem = 'OPERADOR' where id = $1", [ALUNA]);

  const linha = async () => (await s.query(
    "select data_retorno::text as d, hora_retorno as h, retorno_origem as o, retorno_confirmado_em::text as c from public.alunos where id = $1", [ALUNA])).rows[0];
  const antes = await linha();

  // SESSAO A: recalculo. Pausa (pg_sleep) dentro da calibragem: depois da leitura
  // inicial do aluno, antes da escrita.
  await a.query("select set_config('teste.pausa','1',false)");
  const pidA = (await a.query("select pg_backend_pid() as p")).rows[0].p;
  const pidB = (await b.query("select pg_backend_pid() as p")).rows[0].p;
  const pA = a.query("select public.recalcular_situacao_aluno($1, 'virada_d5')", [ALUNA]);
  // ponto de sincronizacao deterministico: A esta de fato dormindo dentro do recalculo
  let aDentro = false;
  for (let k = 0; k < 20000 && !aDentro; k += 1) {
    const r = await s.query("select wait_event as ev from pg_stat_activity where pid = $1", [pidA]);
    if (r.rows[0] && r.rows[0].ev === "PgSleep") aDentro = true;
    else await new Promise((res) => setTimeout(res, 2));
  }
  // SESSAO B: "Ja falei" e reagendamento humano para AMANHA 09:00, com A parada no meio
  await b.query("select set_config('teste.uid', $1, false), set_config('teste.email', $2, false)", [UID, OP]);
  let erroB = null;
  let bDone = false;
  const pB = b.query("select public.agenda_confirmar_retorno($1, true)", [ALUNA])
    .then(() => b.query("select public.agenda_reagendar_retorno($1, current_date + 1, '09:00', false)", [ALUNA]))
    .catch((e) => { erroB = e.message; })
    .finally(() => { bDone = true; });
  // B fica bloqueada por lock se o recalculo travou a linha; detectado em pg_stat_activity
  let bloqueadoPorLock = false;
  for (let k = 0; k < 20000 && !bloqueadoPorLock && !bDone; k += 1) {
    const r = await s.query("select wait_event_type as w from pg_stat_activity where pid = $1", [pidB]);
    if (r.rows[0] && r.rows[0].w === "Lock") bloqueadoPorLock = true;
    else await new Promise((res) => setTimeout(res, 2));
  }
  console.log("a_dormindo_dentro_do_recalculo=" + aDentro + " b_bloqueada_por_lock=" + bloqueadoPorLock);
  await pA;
  await pB;
  const depois = await linha();

  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const preservado = depois.d === amanha && depois.h === "09:00";
  console.log(JSON.stringify({ modo: MODO, antes, erro_b: erroB, depois_da_virada_concorrente: depois }, null, 1));
  console.log(preservado ? "RESULTADO: reagendamento preservado" : "RESULTADO: perda de atualizacao (o recalculo sobrescreveu o reagendamento confirmado)");
  for (const c of [a, b, s]) await c.end();
})().catch((e) => {
  console.error("ERRO", e.message);
  process.exit(1);
});

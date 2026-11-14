// =============================================================================
// Testes de PERSISTÊNCIA da migration 20261111140000 contra Postgres real.
//
// Cobre: CHECK, chave única, unicidade de previa_id, chave estrangeira, NOT NULL
// (falha de gravação), grants e RLS, consumo único da prévia, prévia expirada,
// outra conta, idempotência e consumo com DUAS CONEXÕES simultâneas, guarda
// contra objeto preexistente, e rollback que remove SOMENTE o que a migration criou.
//
// Uso (CI e local):
//   NODE_PATH=<dir com o pacote pg> PGHOST=... PGPORT=... PGUSER=... PGPASSWORD=... \
//     node supabase/tests/ulbra_conexao_envio/run.cjs
// Sai com código 1 se qualquer verificação falhar.
// =============================================================================
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "../../..");
const MIG = path.join(ROOT, "supabase/aguardando_aprovacao/20261111140000_ulbra_conexao_individual_e_envio.sql.pendente");
const ROLL = path.join(ROOT, "supabase/aguardando_aprovacao/20261111140000_ulbra_conexao_individual_e_envio.rollback.sql");

const cfg = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
};

const AT = "0123456789abcdef01234567";
const HASH = "a".repeat(64);
const PREVIA_OK = "11111111-1111-1111-1111-111111111111";
const CONSUMIR = "update public.ulbra_envio_previas set consumida_em = $2 where id = $1 and operador_email = $3 and consumida_em is null and expira_em > $2 returning id";
const OP = "op@x.com.br";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function conectar(database) {
  const c = new Client({ ...cfg, database });
  await c.connect();
  return c;
}
async function criarBanco(nome) {
  const admin = await conectar("postgres");
  await admin.query(`drop database if exists ${nome} with (force)`);
  await admin.query(`create database ${nome}`);
  await admin.end();
}
async function garantirRoles() {
  // Em Supabase estes papéis já existem. Em Postgres puro, o teste os cria.
  const admin = await conectar("postgres");
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$`);
  await admin.end();
}

async function snapshot(c) {
  const t = await c.query(`select relname as n from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','v','m','p') order by 1`);
  const f = await c.query(`select proname as n from pg_proc where pronamespace = 'public'::regnamespace order by 1`);
  const i = await c.query(`select indexname as n from pg_indexes where schemaname = 'public' order by 1`);
  return { tabelas: t.rows.map((r) => r.n), funcoes: f.rows.map((r) => r.n), indices: i.rows.map((r) => r.n) };
}

const resultados = [];
let falhas = 0;
async function teste(nome, fn) {
  try {
    await fn();
    resultados.push(`OK    ${nome}`);
  } catch (e) {
    falhas++;
    resultados.push(`FAIL  ${nome} -> ${e.message}`);
  }
}
async function esperaErro(promessa, codigo) {
  try {
    await promessa;
  } catch (e) {
    if (e.code !== codigo) throw new Error(`código ${e.code} em vez de ${codigo}: ${e.message}`);
    return;
  }
  throw new Error(`deveria falhar com ${codigo}`);
}
function igual(obtido, esperado, msg) {
  if (JSON.stringify(obtido) !== JSON.stringify(esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
  }
}

async function main() {
  await garantirRoles();
  await criarBanco("teste");
  const c = await conectar("teste");

  // ---------------------------------------------------------------- preexistente
  // Objetos que NÃO são desta migration. Devem sobreviver à migração e ao rollback.
  await c.query("create table public.ulbra_outro_objeto (id int primary key)");
  await c.query("insert into public.ulbra_outro_objeto values (1), (2)");
  await c.query("create function public.ulbra_outra_fn() returns int language sql as $$ select 1 $$");
  const antes = await snapshot(c);

  // ---------------------------------------------------------------- migração
  await c.query(fs.readFileSync(MIG, "utf8"));
  const depois = await snapshot(c);
  const criados = depois.tabelas.filter((t) => !antes.tabelas.includes(t)).sort();
  igual(criados, ["ulbra_conexoes_operador", "ulbra_conexoes_pedidos", "ulbra_envio_previas", "ulbra_envios"], "tabelas criadas pela migração");
  igual(depois.funcoes, antes.funcoes, "migração não cria nem altera funções");

  // Fixture: uma prévia válida para os testes de envio.
  await c.query("insert into public.ulbra_envio_previas (id, operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, expira_em, criado_em) values ($1, $2, $3, 'cli-1', $4, now() + interval '5 minutes', now())", [PREVIA_OK, OP, AT, HASH]);

  // ---------------------------------------------------------------- CHECK e restrições
  await teste("texto vazio é recusado (CHECK 1..4096)", () =>
    esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-vazia-01', $1, $2, '', 'PENDENTE')", [OP, AT]), "23514"));
  await teste("texto de 4097 é recusado; 4096 passa", async () => {
    await esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-longa-01', $1, $2, repeat('x', 4097), 'PENDENTE')", [OP, AT]), "23514");
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-limite-01', $1, $2, repeat('x', 4096), 'PENDENTE')", [OP, AT]);
  });
  await teste("chave com 7 e com 81 caracteres é recusada (CHECK 8..80)", async () => {
    await esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('1234567', $1, $2, 'oi', 'PENDENTE')", [OP, AT]), "23514");
    await esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values (repeat('k', 81), $1, $2, 'oi', 'PENDENTE')", [OP, AT]), "23514");
  });
  await teste("atendimento fora do formato hexadecimal de 24 é recusado", () =>
    esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-fmt-0001', $1, 'XYZ', 'oi', 'PENDENTE')", [OP]), "23514"));
  await teste("status fora da lista é recusado", () =>
    esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-st-0001', $1, $2, 'oi', 'ENVIANDO2')", [OP, AT]), "23514"));
  await teste("chave repetida para o mesmo operador dá 23505 (classificado como 'já processado')", async () => {
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-dup-0001', $1, $2, 'oi', 'ENVIADO')", [OP, AT]);
    await esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-dup-0001', $1, $2, 'outro', 'PENDENTE')", [OP, AT]), "23505");
  });
  await teste("falha de gravação que NÃO é chave repetida dá 23502 (não vira 'já processado')", () =>
    esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-nn-0001', $1, $2, NULL, 'PENDENTE')", [OP, AT]), "23502"));
  await teste("e-mail da prévia precisa ser minúsculo", () =>
    esperaErro(c.query("insert into public.ulbra_envio_previas (operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, expira_em) values ('OP@x.com.br', $1, 'c', $2, now() + interval '5 minutes')", [AT, HASH]), "23514"));
  await teste("hash fora de 64 hexadecimais é recusado", () =>
    esperaErro(c.query("insert into public.ulbra_envio_previas (operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, expira_em) values ($1, $2, 'c', 'abc', now() + interval '5 minutes')", [OP, AT]), "23514"));
  await teste("prévia com validade anterior à criação é recusada", () =>
    esperaErro(c.query("insert into public.ulbra_envio_previas (operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, expira_em, criado_em) values ($1, $2, 'c', $3, now() - interval '1 minute', now())", [OP, AT, HASH]), "23514"));
  await teste("uma prévia gera no máximo um envio (previa_id único)", async () => {
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status, previa_id) values ('chave-pv-0001', $1, $2, 'oi', 'ENVIADO', $3)", [OP, AT, PREVIA_OK]);
    await esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status, previa_id) values ('chave-pv-0002', $1, $2, 'oi', 'PENDENTE', $3)", [OP, AT, PREVIA_OK]), "23505");
  });
  await teste("previa_id inexistente é recusado pela chave estrangeira", () =>
    esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status, previa_id) values ('chave-fk-0001', $1, $2, 'oi', 'PENDENTE', '22222222-2222-2222-2222-222222222222')", [OP, AT]), "23503"));

  await teste("expiração acima de 10 minutos é recusada pelo banco (validade máxima)", () =>
    esperaErro(c.query("insert into public.ulbra_envio_previas (operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, criado_em, expira_em) values ($1, $2, 'c', $3, now(), now() + interval '20 minutes')", [OP, AT, HASH]), "23514"));
  await teste("texto em aberto (PENDENTE/ENVIANDO/FALHA_INCERTA) bloqueia outro envio do mesmo texto no atendimento", async () => {
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-aberto-01', $1, $2, 'texto-aberto-unico', 'FALHA_INCERTA')", [OP, AT]);
    await esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-aberto-02', $1, $2, 'texto-aberto-unico', 'PENDENTE')", [OP, AT]), "23505");
  });
  await teste("depois de ENVIADO, o mesmo texto pode ser enviado de novo (índice só vale para aberto)", async () => {
    await c.query("update public.ulbra_envios set status = 'ENVIADO' where chave = 'chave-aberto-01'");
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-aberto-02', $1, $2, 'texto-aberto-unico', 'PENDENTE')", [OP, AT]);
  });

  await teste("texto de 4096 caracteres, acentuado e não repetitivo, grava e a duplicata em aberto é barrada", async () => {
    const alfabeto = "áéíóúçãõàêôabcdefghijklmnopqrstuvwxyzÁÉÍÓÚÇ0123456789 ";
    let seed = 7;
    let texto = "";
    while (texto.length < 4096) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      texto += alfabeto[seed % alfabeto.length];
    }
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-longo-acento-1', $1, $2, $3, 'PENDENTE')", [OP, AT, texto]);
    await esperaErro(c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-longo-acento-2', $1, $2, $3, 'PENDENTE')", [OP, AT, texto]), "23505");
  });
  await teste("status de conferência (CONFIRMADO_ENVIADO / CONFIRMADO_NAO_ENVIADO) é aceito pelo CHECK e libera o índice", async () => {
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-conf-0', $1, $2, 'texto-conferido-sim', 'CONFIRMADO_ENVIADO')", [OP, AT]);
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-conf-1', $1, $2, 'texto-conferido-unico', 'CONFIRMADO_NAO_ENVIADO')", [OP, AT]);
    await c.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-conf-2', $1, $2, 'texto-conferido-unico', 'PENDENTE')", [OP, AT]);
  });

  // ---------------------------------------------------------------- consumo (sequencial)
  await teste("outra conta não consome a prévia", async () => {
    const r = await c.query(CONSUMIR, [PREVIA_OK, new Date().toISOString(), "outra@x.com.br"]);
    igual(r.rowCount, 0, "linhas consumidas por outra conta");
  });
  await teste("prévia expirada não é consumida", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    await c.query("insert into public.ulbra_envio_previas (id, operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, expira_em, criado_em) values ($1, $2, $3, 'cli-1', $4, now() - interval '1 minute', now() - interval '10 minutes')", [id, OP, AT, HASH]);
    const r = await c.query(CONSUMIR, [id, new Date().toISOString(), OP]);
    igual(r.rowCount, 0, "linhas consumidas com prévia expirada");
  });
  await teste("consumo único sequencial: a segunda tentativa não consome", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    await c.query("insert into public.ulbra_envio_previas (id, operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, expira_em) values ($1, $2, $3, 'cli-1', $4, now() + interval '5 minutes')", [id, OP, AT, HASH]);
    const a = await c.query(CONSUMIR, [id, new Date().toISOString(), OP]);
    const b = await c.query(CONSUMIR, [id, new Date().toISOString(), OP]);
    igual([a.rowCount, b.rowCount], [1, 0], "consumos (primeiro, segundo)");
  });

  // ---------------------------------------------------------------- grants e RLS
  await teste("anon e authenticated não leem nem escrevem as tabelas novas", async () => {
    for (const tb of ["ulbra_envio_previas", "ulbra_envios", "ulbra_conexoes_operador", "ulbra_conexoes_pedidos"]) {
      for (const papel of ["anon", "authenticated"]) {
        const r = await c.query("select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i", [papel, "public." + tb]);
        igual([r.rows[0].s, r.rows[0].i], [false, false], `${papel} em ${tb}`);
      }
    }
  });
  await teste("service_role tem o acesso previsto (select, insert e update nas tabelas de envio)", async () => {
    const r = await c.query("select has_table_privilege('service_role', 'public.ulbra_envio_previas', 'update') as u, has_table_privilege('service_role', 'public.ulbra_envios', 'insert') as i");
    igual([r.rows[0].u, r.rows[0].i], [true, true], "privilégios de service_role");
  });
  await teste("RLS ligada nas tabelas novas", async () => {
    const r = await c.query("select relname, relrowsecurity from pg_class where relname in ('ulbra_envio_previas','ulbra_envios','ulbra_conexoes_operador','ulbra_conexoes_pedidos') and relnamespace = 'public'::regnamespace");
    igual(r.rows.every((x) => x.relrowsecurity), true, "RLS em todas as tabelas novas");
    igual(r.rows.length, 4, "tabelas encontradas");
  });

  // ---------------------------------------------------------------- concorrência: DUAS conexões
  await teste("concorrência: duas confirmações simultâneas consomem a mesma prévia UMA vez", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    await c.query("insert into public.ulbra_envio_previas (id, operador_email, atendimento_id, ulbra_cliente_id, conteudo_hash, expira_em) values ($1, $2, $3, 'cli-1', $4, now() + interval '5 minutes')", [id, OP, AT, HASH]);
    const a = await conectar("teste");
    const b = await conectar("teste");
    try {
      const agora = new Date().toISOString();
      // A segura a linha e a mantém por 1 s. B tenta consumir a mesma prévia e espera o COMMIT de A.
      const pA = (async () => {
        await a.query("begin");
        const r = await a.query(CONSUMIR, [id, agora, OP]);
        await a.query("select pg_sleep(1)");
        await a.query("commit");
        return r.rowCount;
      })();
      await sleep(300);
      const pB = b.query(CONSUMIR, [id, new Date().toISOString(), OP]).then((r) => r.rowCount);
      const [ra, rb] = await Promise.all([pA, pB]);
      igual([ra, rb], [1, 0], "linhas consumidas por A e por B");
    } finally {
      await a.end();
      await b.end();
    }
  });

  await teste("concorrência: chaves DIFERENTES com o mesmo texto e atendimento geram UM envio em aberto", async () => {
    const a = await conectar("teste");
    const b = await conectar("teste");
    try {
      const texto = "texto-concorrente-diferente";
      const pA = (async () => {
        await a.query("begin");
        await a.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-cc-a-0001', $1, $2, $3, 'PENDENTE')", [OP, AT, texto]);
        await a.query("select pg_sleep(1)");
        await a.query("commit");
        return "gravou";
      })();
      await sleep(300);
      const pB = b.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ('chave-cc-b-0002', $1, $2, $3, 'PENDENTE')", [OP, AT, texto])
        .then(() => "gravou", (e) => (e.constraint || e.message || "").includes("texto_em_aberto") ? "bloqueado_texto_em_aberto" : e.code);
      const [ra, rb] = await Promise.all([pA, pB]);
      igual([ra, rb], ["gravou", "bloqueado_texto_em_aberto"], "resultado de A e de B");
    } finally {
      await a.end();
      await b.end();
    }
  });

  await teste("concorrência: mesma chave em duas conexões gera UM envio; a outra dá 23505", async () => {
    const chave = "chave-concorrente-01";
    const a = await conectar("teste");
    const b = await conectar("teste");
    try {
      const pA = (async () => {
        await a.query("begin");
        await a.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ($1, $2, $3, 'oi', 'PENDENTE')", [chave, OP, AT]);
        await a.query("select pg_sleep(1)");
        await a.query("commit");
        return "gravou";
      })();
      await sleep(300);
      const pB = b.query("insert into public.ulbra_envios (chave, operador_email, atendimento_id, texto, status) values ($1, $2, $3, 'oi', 'PENDENTE')", [chave, OP, AT])
        .then(() => "gravou", (e) => e.code);
      const [ra, rb] = await Promise.all([pA, pB]);
      igual([ra, rb], ["gravou", "23505"], "resultado de A e de B");
      const n = await c.query("select count(*)::int as n from public.ulbra_envios where chave = $1", [chave]);
      igual(n.rows[0].n, 1, "envios gravados com a mesma chave");
    } finally {
      await a.end();
      await b.end();
    }
  });

  // ---------------------------------------------------------------- rollback com histórico
  await teste("rollback RECUSA quando há histórico (envios, prévias ou conexões) e não altera nada", async () => {
    const antesRollback = await snapshot(c);
    let erro = null;
    try { await c.query(fs.readFileSync(ROLL, "utf8")); } catch (e) { erro = e; }
    if (!erro || !/ROLLBACK_RECUSADO_HA_HISTORICO/.test(erro.message)) throw new Error("rollback deveria recusar: " + (erro ? erro.message : "não recusou"));
    igual(await snapshot(c), antesRollback, "objetos depois do rollback recusado");
  });
  await c.end();

  // ---------------------------------------------------------------- rollback limpo (banco sem histórico)
  await teste("rollback limpo remove SOMENTE os objetos da migração e preserva os preexistentes", async () => {
    await criarBanco("teste_rollback");
    const r = await conectar("teste_rollback");
    try {
      await r.query("create table public.ulbra_outro_objeto (id int primary key)");
      await r.query("insert into public.ulbra_outro_objeto values (1), (2)");
      await r.query("create function public.ulbra_outra_fn() returns int language sql as $$ select 1 $$");
      const antesMigracao = await snapshot(r);
      await r.query(fs.readFileSync(MIG, "utf8"));
      await r.query(fs.readFileSync(ROLL, "utf8"));
      igual(await snapshot(r), antesMigracao, "objetos após o rollback limpo (devem ser os de antes da migração)");
      const n = await r.query("select count(*)::int as n from public.ulbra_outro_objeto");
      igual(n.rows[0].n, 2, "linhas do objeto preexistente");
    } finally {
      await r.end();
    }
  });

  // ---------------------------------------------------------------- guarda contra objeto preexistente
  await teste("migração aborta, sem alterar nada, quando ulbra_envios já existe", async () => {
    await criarBanco("teste_guarda");
    const g = await conectar("teste_guarda");
    try {
      await g.query("create table public.ulbra_envios (id int)");
      const antesGuarda = await snapshot(g);
      let erro = null;
      try {
        await g.query(fs.readFileSync(MIG, "utf8"));
      } catch (e) {
        erro = e;
      }
      if (!erro || !/MIGRATION_20261111140000/.test(erro.message)) throw new Error("a migração deveria abortar com a guarda: " + (erro ? erro.message : "não abortou"));
      igual(await snapshot(g), antesGuarda, "objetos depois da migração abortada");
    } finally {
      await g.end();
    }
  });

  console.log(resultados.join("\n"));
  console.log(falhas ? `\nFALHOU: ${falhas} verificação(ões)` : `\nTodas passaram: ${resultados.length}`);
  process.exitCode = falhas ? 1 : 0;
}

main().catch((e) => {
  console.error("erro fatal:", e);
  process.exitCode = 1;
});

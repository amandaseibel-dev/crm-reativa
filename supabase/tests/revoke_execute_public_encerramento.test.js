// PRIVILEGIO EFETIVO DAS SEIS FUNCOES DO ENCERRAMENTO (migration 20261027160000).
//
// CONTEXTO: em 27/10/2026, cinco dessas funcoes estavam com EXECUTE para PUBLIC
// em producao e eram chamaveis por `anon` pela API publica -- medido por sonda
// HTTP, cinco respostas 200 antes e cinco 401/42501 depois. A contencao
// emergencial foi aplicada FORA DE MIGRATION, as 15:25 UTC. Evidencia em
// docs/seguranca/RELATORIO-P0-REVOKE-ENCERRAMENTO-2026-10-27.md
//
// A SEXTA, `caso_encerrado_operacional(text,text,text,text,text)`, ja estava sem
// PUBLIC em producao -- mas entra no escopo porque e CAMINHO EQUIVALENTE:
// `security definer`, sem portao interno, recebe CPF por parametro e delega para
// `_caso_encerrado_operacional_regra`. Revogar so a interna nao fecha por ela.
//
// O QUE ESTE ARQUIVO PROVA, e por que ele vale mais que uma catraca de texto:
//   T1  em Postgres novo, as seis NASCEM com EXECUTE para PUBLIC -- a premissa
//       que a estrategia de reconciliacao tratava como NAO COMPROVADA;
//   T2  a migration existe em disco (vermelho enquanto nao for escrita);
//   T3  depois dela, PUBLIC e `anon` NAO executam nenhuma das seis;
//   T4  depois dela, `authenticated` e `service_role` MANTEM EXECUTE nas seis --
//       a metade contraria, sem a qual um `revoke` exagerado passaria verde.
//
// Afirma PRIVILEGIO EFETIVO (`has_function_privilege`), nunca `aclexplode` sobre
// `proacl`: `proacl` NULO e o estado PADRAO, que para funcao INCLUI EXECUTE a
// PUBLIC, e `aclexplode` de um nulo devolve zero linhas -- diria "sem PUBLIC"
// num caso em que PUBLIC executa.
//
// NENHUM DADO REAL: a bancada usa CPFs, nomes e valores inventados.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 90000, hookTimeout: 240000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const PASTA_MIGRACOES = "supabase/" + "migrations";

const FIXTURE = ler("supabase/tests/fixtures/grupo_a_prod_20260918.sql");
const ACORDO_CANCELADO = ler("supabase/migrations/20260918000000_acordo_cancelado_nao_cancela_cobranca.sql");
const GRUPO_A = ler("supabase/migrations/20260918150000_grupo_a_confirmacao_prime.sql");
const ALINHAR = ler("supabase/tests/fixtures/encerramento_sem_saldo_alinhar_prod_20261026.sql");
const REGRA = ler("supabase/migrations/20261026200000_encerramento_sem_saldo_validacao_financeira.sql");

// A migration desta entrega pode ainda nao existir: `P3/migration` barra a
// escrita em `supabase/migrations/` enquanto o canal da Fase 2 nao estiver
// liberado para a branch. O teste NAO finge que ela existe.
// O md5 aprovado pela gestao em 27/10/2026 esta cravado aqui de proposito: o
// sentinela nao pergunta so "o arquivo existe", pergunta "o arquivo e O
// aprovado". Editar a migration sem reaprovar fica vermelho.
const MIGRACOES = [
  { nome: "20261027160000_revoke_execute_public_encerramento.sql",
    md5: "32e906b049244a518e6c089732dcb571" },
  { nome: "20261027170000_revoke_authenticated_auxiliares_encerramento.sql",
    md5: "23b02327dd011af45bc6429eed67a35e" },
].map((m) => {
  const caminho = `${PASTA_MIGRACOES}/${m.nome}`;
  try {
    const sql = ler(caminho);
    return { ...m, caminho, sql, md5_real: createHash("md5").update(sql).digest("hex") };
  } catch (e) {
    return { ...m, caminho, sql: null, md5_real: null,
             erro: e.code === "ENOENT" ? "ausente" : String(e.message) };
  }
});
const [M160, M170] = MIGRACOES;
const REVOGACAO = M160.sql;

// As SEIS assinaturas, qualificadas por schema de proposito: a saida de
// `regprocedure` so omite `public.` quando `public` esta visivel no
// `search_path`, e comparar texto sem schema casaria zero linhas em silencio.
const SEIS = [
  "public._caso_sem_saldo_conferido(uuid,text)",
  "public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)",
  "public._encerramento_congelado(uuid,uuid,text,text,text,text,text)",
  "public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)",
  "public.caso_encerrado_operacional(text,text,text,text,text)",
  "public.caso_encerramento_congelado(uuid)",
];

async function privilegios(db) {
  const valores = SEIS.map((s) => `(${JSON.stringify(s).replace(/"/g, "'")})`).join(",");
  const { rows } = await db.query(`
    select a.sig,
           has_function_privilege('public',        to_regprocedure(a.sig), 'EXECUTE') as pub,
           has_function_privilege('anon',          to_regprocedure(a.sig), 'EXECUTE') as anon,
           has_function_privilege('authenticated', to_regprocedure(a.sig), 'EXECUTE') as auth,
           has_function_privilege('service_role',  to_regprocedure(a.sig), 'EXECUTE') as srv,
           to_regprocedure(a.sig) is not null as existe
      from (values ${valores}) as a(sig)
     order by a.sig`);
  return rows;
}

// O `pg_default_acl` medido em PRODUCAO para o schema `public`, papel `postgres`:
//   {postgres=X, authenticated=X, service_role=X}  -- SEM PUBLIC, SEM anon
// Quando existe entrada em `pg_default_acl`, ela SUBSTITUI o padrao de fabrica.
// Logo um projeto Supabase novo NAO e um Postgres cru, e medir sem isto mede
// outra coisa.
const PADRAO_DE_PRODUCAO = `
  alter default privileges for role postgres in schema public
    revoke execute on functions from public;
  alter default privileges for role postgres in schema public
    grant execute on functions to authenticated, service_role;
`;

async function bancada({ comPadraoDeProducao = false } = {}) {
  const db = new PGlite({ extensions: { unaccent } });
  await db.exec(FIXTURE);
  if (comPadraoDeProducao) await db.exec(PADRAO_DE_PRODUCAO);
  await db.exec(ACORDO_CANCELADO);
  await db.exec(GRUPO_A);
  await db.exec(ALINHAR);
  await db.exec(REGRA);
  return db;
}

describe("Revogação de EXECUTE de PUBLIC — as seis funções do encerramento", () => {
  let antes = null;

  beforeAll(async () => {
    const db = await bancada();
    antes = await privilegios(db);
  });

  it("T1: em Postgres novo, as seis NASCEM com EXECUTE para PUBLIC", () => {
    // Esta e a premissa que a estrategia de reconciliacao tratava como NAO
    // COMPROVADA: se o ambiente novo reproduz a exposicao. Aqui ela e MEDIDA.
    expect(antes).toHaveLength(6);
    for (const f of antes) {
      expect(f.existe, `${f.sig} deveria existir depois de 20261026200000`).toBe(true);
      expect(f.pub, `${f.sig}: PUBLIC deveria executar num banco novo`).toBe(true);
    }
  });

  it("T1b: e `anon` alcança as seis por PUBLIC, sem concessão direta", () => {
    for (const f of antes) {
      expect(f.anon, `${f.sig}: anon deveria alcancar por PUBLIC`).toBe(true);
    }
  });

  it("T1c: MESMO com o pg_default_acl de producao, PUBLIC aparece -- porque `create or replace` preserva ACL", async () => {
    // O experimento decisivo, e a CAUSA RAIZ que ficou duas vezes declarada
    // como nao comprovada.
    //
    // Replicando o `pg_default_acl` medido em producao para o papel `postgres`
    // no schema `public` -- {authenticated=X, service_role=X}, SEM PUBLIC --,
    // as seis AINDA nascem com `=X`, e a ACL resultante e identica a de
    // producao: {=X, postgres=X, authenticated=X, service_role=X}.
    //
    // Por que: as funcoes JA EXISTEM quando as migrations rodam, e
    // `create or replace` PRESERVA a ACL existente, ignorando o privilegio
    // padrao. O `=X` vem da PRIMEIRA criacao, sob o padrao de fabrica do
    // PostgreSQL (que inclui PUBLIC), e nenhuma migration jamais o revogou.
    //
    // Consequencia pratica, e e o que justifica a migration: mudar
    // `pg_default_acl` NAO conserta funcao existente, e ambiente novo que
    // reaplique as migrations herda o `=X` do mesmo jeito. So um `revoke`
    // explicito fecha.
    const db = await bancada({ comPadraoDeProducao: true });
    const r = await privilegios(db);
    expect(r).toHaveLength(6);
    for (const f of r) {
      expect(f.existe, `${f.sig} deveria existir`).toBe(true);
      expect(f.pub, `${f.sig}: PUBLIC executa mesmo sob o padrao de producao`).toBe(true);
      expect(f.auth, `${f.sig}: authenticated deveria executar`).toBe(true);
      expect(f.srv, `${f.sig}: service_role deveria executar`).toBe(true);
    }
  });

  it("T2: as duas migrations existem em disco E têm o md5 aprovado", () => {
    for (const m of MIGRACOES) {
      expect(
        m.sql,
        `${m.caminho} esta ${m.erro ?? "ausente"}. A escrita na pasta de ` +
          "migrations depende do canal da Fase 2 de Banco (P3/migration). " +
          "Enquanto este teste estiver vermelho, a propriedade de seguranca " +
          "NAO esta garantida em ambiente novo -- so em producao, onde a " +
          "contencao foi aplicada fora de migration em 27/10/2026."
      ).not.toBeNull();
      expect(
        m.md5_real,
        `${m.nome} nao e o arquivo aprovado pela gestao em 27/10/2026. ` +
          `Esperado md5 ${m.md5}, encontrado ${m.md5_real}. ` +
          "Se a mudanca foi deliberada, reaprove e atualize o md5 aqui."
      ).toBe(m.md5);
    }
  });

  describe.skipIf(!REVOGACAO)("depois de aplicar a migration", () => {
    let depois = null;

    beforeAll(async () => {
      const db = await bancada();
      await db.exec(REVOGACAO);
      depois = await privilegios(db);
    });

    it("T3: PUBLIC e anon NÃO executam nenhuma das seis", () => {
      for (const f of depois) {
        expect(f.pub, `${f.sig}: PUBLIC ainda executa`).toBe(false);
        expect(f.anon, `${f.sig}: anon ainda executa`).toBe(false);
      }
    });

    it("T4: authenticated e service_role MANTÊM EXECUTE nas seis", () => {
      // A metade contraria. Sem ela, um revoke exagerado passaria verde.
      for (const f of depois) {
        expect(f.auth, `${f.sig}: authenticated perdeu EXECUTE`).toBe(true);
        expect(f.srv, `${f.sig}: service_role perdeu EXECUTE`).toBe(true);
      }
    });

    it("T5b: a ORDEM é obrigatória — a 170000 antes da 160000 ABORTA", async () => {
      // Medido em 27/10/2026: `authenticated` alcanca as auxiliares POR PUBLIC.
      // Revogar `authenticated` antes de fechar PUBLIC seria inocuo, e a guarda
      // da 170000 recusa em vez de fingir que fez algo.
      const db = await bancada();
      await expect(db.exec(M170.sql)).rejects.toThrow(/CAMINHO_ANONIMO_ABERTO/);
    });

    it("T5e: estado PARCIAL também aborta — os wrappers não podem ficar abertos", async () => {
      // O furo que o segundo ajuste fechou, em 27/10/2026. A guarda antiga
      // olhava so PUBLIC e so as QUATRO auxiliares: fechadas elas, a 170000
      // terminava VERDE com o caminho anonimo ainda aberto pelos wrappers
      // `caso_encerrado_operacional`, que sao `security definer` e alcancam as
      // auxiliares com os direitos do dono. Agora a guarda olha as SEIS e
      // tambem `anon`.
      const db = await bancada();
      for (const sig of [
        "public._caso_sem_saldo_conferido(uuid,text)",
        "public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)",
        "public._encerramento_congelado(uuid,uuid,text,text,text,text,text)",
        "public.caso_encerramento_congelado(uuid)",
      ]) {
        await db.exec(`revoke execute on function ${sig} from public, anon;`);
      }
      await expect(db.exec(M170.sql)).rejects.toThrow(/CAMINHO_ANONIMO_ABERTO/);
    });

    it("T5c: na ordem certa, o estado final é exatamente o pretendido", async () => {
      const db = await bancada();
      await db.exec(M160.sql);
      await db.exec(M170.sql);
      const r = await privilegios(db);
      const aux = r.filter((f) => !f.sig.startsWith("public.caso_encerrado_operacional("));
      const pub2 = r.filter((f) => f.sig.startsWith("public.caso_encerrado_operacional("));
      expect(aux).toHaveLength(4);
      expect(pub2).toHaveLength(2);
      for (const f of r) {
        expect(f.pub, `${f.sig}: PUBLIC`).toBe(false);
        expect(f.anon, `${f.sig}: anon`).toBe(false);
        expect(f.srv, `${f.sig}: service_role deve manter`).toBe(true);
      }
      for (const f of aux) expect(f.auth, `${f.sig}: authenticated deve sair das auxiliares`).toBe(false);
      for (const f of pub2) expect(f.auth, `${f.sig}: authenticated deve ficar nas publicas`).toBe(true);
    });

    it("T5d: reaplicar as duas, na ordem, não quebra", async () => {
      // Defeito achado e corrigido em 27/10/2026 antes de publicar: a
      // conferencia da 160000 exigia `authenticated` nas SEIS, e a 170000 o
      // remove das quatro de proposito -- reaplicar abortava com mensagem
      // enganosa. Hoje a 160000 exige `authenticated` so nas DUAS publicas.
      const db = await bancada();
      await db.exec(M160.sql);
      await db.exec(M170.sql);
      await db.exec(M160.sql);
      await db.exec(M170.sql);
      const r = await privilegios(db);
      for (const f of r) expect(f.pub, `${f.sig}: PUBLIC`).toBe(false);
    });

    it("T5: a migration é idempotente — aplicar duas vezes não quebra", () => {
      // `revoke` de privilegio ausente e no-op. Mas NAO e idempotente em geral:
      // papel inexistente levanta 42704, e executor sem direito emite WARNING
      // sem revogar. Aqui os papeis existem pela fixture.
      return (async () => {
        const db = await bancada();
        await db.exec(REVOGACAO);
        await db.exec(REVOGACAO);
        const d = await privilegios(db);
        for (const f of d) {
          expect(f.pub).toBe(false);
          expect(f.auth).toBe(true);
        }
      })();
    });
  });
});

// Revogar `authenticated` das quatro auxiliares e mudanca de ACL, nao de logica.
// Inline aqui de proposito: o teste nao duplica regra sob teste, apenas monta o
// estado de privilegio cujo efeito ele quer medir.
const REVOGA_PUBLIC = `
  revoke execute on function public._caso_sem_saldo_conferido(uuid, text)                                 from public, anon;
  revoke execute on function public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text) from public, anon;
  revoke execute on function public._encerramento_congelado(uuid,uuid,text,text,text,text,text)           from public, anon;
  revoke execute on function public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)        from public, anon;
  revoke execute on function public.caso_encerrado_operacional(text,text,text,text,text)                  from public, anon;
  revoke execute on function public.caso_encerramento_congelado(uuid)                                     from public, anon;
`;

const REVOGA_AUTHENTICATED = `
  revoke execute on function public._caso_sem_saldo_conferido(uuid, text)                                 from authenticated;
  revoke execute on function public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text) from authenticated;
  revoke execute on function public._encerramento_congelado(uuid,uuid,text,text,text,text,text)           from authenticated;
  revoke execute on function public.caso_encerramento_congelado(uuid)                                     from authenticated;
`;

describe("Os rollbacks — efeito trancado, não só arquivo preparado", () => {
  // O Guardiao apontou, com razao, que o §4 do P1 afirmava cinco cenarios
  // validados em bancada e o quinto -- o efeito do rollback -- nao era exercido
  // por teste nenhum. "Rollback preparado" valia como arquivo existente, nao
  // como efeito comprovado. Estes quatro testes fecham isso.
  const RB = "supabase/" + "rollbacks/";
  const RB160 = (() => {
    try { return ler(RB + "20261027160000_revoke_execute_public_encerramento.rollback.sql"); }
    catch { return null; }
  })();
  const RB170 = (() => {
    try { return ler(RB + "20261027170000_revoke_authenticated_auxiliares_encerramento.rollback.sql"); }
    catch { return null; }
  })();

  it("RB0: os dois arquivos de rollback existem", () => {
    expect(RB160, "rollback da 160000 ausente").not.toBeNull();
    expect(RB170, "rollback da 170000 ausente").not.toBeNull();
  });

  it("RB1: o rollback da 170000 devolve `authenticated` às quatro e MANTÉM PUBLIC fechado", async () => {
    const db = await bancada();
    await db.exec(M160.sql);
    await db.exec(M170.sql);
    await db.exec(RB170);
    const r = await privilegios(db);
    const aux = r.filter((f) => !f.sig.startsWith("public.caso_encerrado_operacional("));
    expect(aux).toHaveLength(4);
    for (const f of aux) expect(f.auth, `${f.sig}: authenticated deveria voltar`).toBe(true);
    for (const f of r) {
      expect(f.pub, `${f.sig}: PUBLIC NAO pode voltar -- seria reabrir o P0`).toBe(false);
      expect(f.anon, `${f.sig}: anon NAO pode voltar`).toBe(false);
    }
  });

  it("RB2: o rollback da 170000 RECUSA se o P0 tiver sido reaberto antes", async () => {
    // Um rollback que reabrisse o acesso anonimo seria pior que nao ter
    // rollback. O arquivo aborta com P0_REABERTO.
    const db = await bancada();
    await db.exec(M160.sql);
    await db.exec(M170.sql);
    await db.exec(
      "grant execute on function public._caso_sem_saldo_conferido(uuid, text) to public;"
    );
    await expect(db.exec(RB170)).rejects.toThrow(/P0_REABERTO/);
  });

  it("RB3: o rollback da 160000 restaura PUBLIC em CINCO e deixa a sexta fechada", async () => {
    // Assimetria DELIBERADA, declarada no proprio arquivo: em producao a de 5
    // argumentos nunca teve PUBLIC, e conceder ampliaria acesso em vez de
    // restaurar. Consequencia medida: em ambiente novo, reverter NAO volta ao
    // estado inicial -- a sexta fica fechada.
    const db = await bancada();
    await db.exec(M160.sql);
    await db.exec(M170.sql);
    await db.exec(RB170);
    await db.exec(RB160);
    const r = await privilegios(db);
    const comPublic = r.filter((f) => f.pub);
    expect(comPublic).toHaveLength(5);
    const fechada = r.find((f) => f.sig === "public.caso_encerrado_operacional(text,text,text,text,text)");
    expect(fechada.pub, "a sexta fica fechada, por desenho").toBe(false);
  });
});

describe("Regressão do congelamento — a trava dos 8 casos / R$ 7.584,60", () => {
  // A migration 20261026200000 traz, em comentario, a medicao que esta trava
  // protege: "Sem esta linha, a troca da regra soltaria 8 casos / R$ 7.584,60
  // na primeira passagem". A linha e
  // `and not public.caso_encerramento_congelado(c.id)`, dentro de
  // `casos_elegiveis_liberacao_fidelizacao` e de `casos_reabrir_com_divida`.
  //
  // LIMITE DECLARADO: `public.casos` esta VAZIA na bancada, entao a exclusao
  // ponta a ponta NAO e exercitada. O que este bloco tranca sao as duas pecas
  // de que a exclusao depende -- o predicado e a clausula --, mais a ordem da
  // mudanca de ACL. A trilha de congelamento NAO tem FK em `caso_id` (por
  // desenho, para sobreviver a exclusao do caso), entao um uuid arbitrario
  // serve de alvo.
  //
  // Juntas, R1 e R2 pegam o defeito que quase foi proposto em 27/10: um portao
  // de gestao dentro de `caso_encerramento_congelado` faria o predicado
  // responder pelo JWT do chamador e devolver `false` para todo nao-gestao --
  // soltando os casos em silencio.
  //
  // NENHUM DADO REAL: uuid inventado, valores inventados.
  // A trilha TEM FK em `caso_id` -- conferido em producao em 27/10/2026, contra
  // uma anotacao minha que dizia o contrario (ela valia para a tabela de
  // auditoria de 20261026195000, nao para esta). Logo o alvo precisa ser um
  // caso real, e `public.casos` esta vazia na bancada: criamos um minimo.
  const criarCaso = async (db) =>
    (await db.query("insert into public.casos default values returning id")).rows[0].id;

  const congelar = (db, alvo) =>
    db.query(
      `insert into public.caso_encerramento_sem_saldo
         (escopo, caso_id, classificacao, saldo_no_momento, origem, justificativa, estado_anterior)
       values ('CASO', $1, 'SALDO_NAO_COMPROVADO', 0, 'MIGRATION', 'congelado pelo teste', '{}')`,
      [alvo]
    );

  const pergunta = async (db, alvo) =>
    (await db.query("select public.caso_encerramento_congelado($1) as r", [alvo])).rows[0].r;

  it("R1: o predicado responde `false` antes e `true` depois de congelar", async () => {
    const db = await bancada();
    const alvo = await criarCaso(db);
    expect(await pergunta(db, alvo), "nao congelado").toBe(false);
    await congelar(db, alvo);
    expect(await pergunta(db, alvo), "congelado").toBe(true);
  });

  it("R2: a mudança de ACL NÃO altera a resposta do predicado", async () => {
    const db = await bancada();
    const alvo = await criarCaso(db);
    await congelar(db, alvo);
    const antes = await pergunta(db, alvo);
    await db.exec(REVOGA_PUBLIC);
    await db.exec(REVOGA_AUTHENTICATED);
    const depois = await pergunta(db, alvo);
    expect(antes, "congelado antes").toBe(true);
    expect(depois, "congelado depois: ACL nao mexe no predicado").toBe(true);
  });

  it("R3: a cláusula de exclusão continua nos dois consumidores", async () => {
    const db = await bancada();
    const { rows } = await db.query(`
      select p.proname,
             position('not public.caso_encerramento_congelado' in p.prosrc) > 0 as tem_clausula
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('casos_elegiveis_liberacao_fidelizacao','casos_reabrir_com_divida')
       order by 1`);
    expect(rows.length, "os dois consumidores precisam existir").toBe(2);
    for (const r of rows) {
      expect(r.tem_clausula, `${r.proname} perdeu a clausula de exclusao do congelado`).toBe(true);
    }
  });

  it("R4: revogar só `authenticated` NÃO fecha nada enquanto PUBLIC tiver EXECUTE", async () => {
    // Achado do proprio teste, em 27/10/2026: `authenticated` alcanca as
    // auxiliares por PUBLIC, nao por concessao propria. Logo o passo 1 do P1
    // DEPENDE de o revoke de PUBLIC ter acontecido antes -- em producao ja
    // aconteceu, em ambiente novo nao.
    const db = await bancada();
    await db.exec(REVOGA_AUTHENTICATED);
    const r1 = await db.query(
      "select has_function_privilege('authenticated','public._caso_sem_saldo_conferido(uuid,text)','EXECUTE') as x"
    );
    expect(r1.rows[0].x, "sem o revoke de PUBLIC, revogar authenticated e inocuo").toBe(true);
  });

  it("R5: na ordem certa, as auxiliares fecham e a pública de 5 args é preservada", async () => {
    const db = await bancada();
    await db.exec(REVOGA_PUBLIC);
    await db.exec(REVOGA_AUTHENTICATED);
    const { rows } = await db.query(`
      select has_function_privilege('authenticated','public.caso_encerrado_operacional(text,text,text,text,text)','EXECUTE') as publica_5,
             has_function_privilege('authenticated','public._caso_sem_saldo_conferido(uuid,text)','EXECUTE')                 as auxiliar,
             has_function_privilege('service_role','public._caso_sem_saldo_conferido(uuid,text)','EXECUTE')                  as auxiliar_srv,
             has_function_privilege('public','public._caso_sem_saldo_conferido(uuid,text)','EXECUTE')                        as auxiliar_pub`);
    expect(rows[0].publica_5, "a publica de 5 args NAO perde authenticated: a operacao depende dela").toBe(true);
    expect(rows[0].auxiliar, "a auxiliar deixa de ser alcancavel por authenticated").toBe(false);
    expect(rows[0].auxiliar_pub, "nem por PUBLIC").toBe(false);
    expect(rows[0].auxiliar_srv, "service_role mantem").toBe(true);
  });
});

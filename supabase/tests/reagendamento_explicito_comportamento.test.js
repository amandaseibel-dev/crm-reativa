// REAGENDAMENTO HUMANO EXPLICITO, PERMISSOES POR OPERACAO, BACKUP E RESTAURACAO
// =============================================================================
// Roda o corpo VIVO de recalcular_situacao_aluno (fixture de 13/11/2026, byte a
// byte), o gatilho e a RPC de confirmacao reais, e os arquivos do pacote:
//   1. 20261113120000_retorno_tratado_nao_herda_selo_do_operador.sql.pendente
//   2. 20261114120000_agenda_reagendar_retorno_e_portao_recalculo.sql.pendente
// Depois confere rollback, backup por id e restauracao filtrada por id.
//
// IDENTIDADES (sessao = set_config em teste.uid / teste.email):
//   sem sessao (anon)        -> teste.uid vazio
//   authenticated sem perfil -> e-mail que nao esta em usuarios
//   operador dono do caso    -> OPERADOR (ativo)
//   operador de outra carteira -> OUTRO (ativo)
//   usuario inativo         -> OPERADOR_INATIVO (existe, ativo = false)
//   Amanda / Fernanda / Amanda ADM -> GESTAO (amanda), cobranca04, cobranca07
//
// PERMISSAO DE GESTAO: a RPC usa public.usuario_e_gestao(), gate que JA EXISTE no
// banco. Sua definicao NAO esta no repositorio. Aqui ela e um STUB que devolve
// verdadeiro para as tres identidades acima. A lista real precisa ser conferida
// em producao antes da aplicacao (pendencia declarada no pacote).
//
// O QUE NAO PROVA: concorrencia real entre duas sessoes (PGlite tem uma conexao).
// Fica para a rodada de staging do pacote. Os grants sao conferidos por
// has_function_privilege; os testes de autorizacao do bloco final trocam de role (SET ROLE); os demais usam superuser com stubs de auth.
import { describe, it, expect, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { retornosAgendados, JANELA_RETORNOS_DIAS } from "../../src/utils/painelMeuDia";
import { retornoParaAvisar } from "../../src/utils/alarmeRetorno";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (...p) => readFileSync(resolve(AQUI, "..", ...p), "utf8");
const lerRaiz = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const md5 = (t) => createHash("md5").update(t, "utf8").digest("hex");

const MD5_VIVO = "41475103b8b7ad363dfdc76c4170c5a8";
const MD5_PARTE1 = "03dacc0abb23490a8e060c4f86e0df94";
// Corpo final (parte 1 + leitura travada da parte 2, secao D do pacote).
const MD5_FINAL = "c3e38ac06719b886297369e1f0e507aa";

const CORPO_VIVO = ler("tests", "fixtures", "recalcular_situacao_aluno_prod_20261113.sql");
const AGENDA_CONFIRMADO = ler("migrations", "20260808150000_agenda_retorno_confirmado.sql");
const P1 = "supabase/aguardando_aprovacao/20261113120000_retorno_tratado_nao_herda_selo_do_operador";
const P2 = "supabase/aguardando_aprovacao/20261114120000_agenda_reagendar_retorno_e_portao_recalculo";
const RESTAURA = "supabase/aguardando_aprovacao/20261114120000_restauracao_por_id";
const P1_PEND = lerRaiz(`${P1}.sql.pendente`);
const P1_ROLL = lerRaiz(`${P1}.rollback.sql`);
const P2_PEND = lerRaiz(`${P2}.sql.pendente`);
const P2_ROLL = lerRaiz(`${P2}.rollback.sql`);
const RESTAURA_PEND = lerRaiz(`${RESTAURA}.sql.pendente`);

const OPERADOR = "operador.teste@exemplo.local";
const OUTRO = "outro.operador@exemplo.local";
const INATIVO = "inativo.teste@exemplo.local";
const SEM_PERFIL = "sem.perfil@exemplo.local";
const AMANDA = "amanda.seibel@aelbra.com.br";
const FERNANDA = "cobranca04@aelbra.com.br";
const AMANDA_ADM = "cobranca07@aelbra.com.br";
const GESTAO = [AMANDA, FERNANDA, AMANDA_ADM];
const ALUNA = "a1000000-0000-4000-8000-000000000001";
const OUTRA = "a1000000-0000-4000-8000-000000000002";

const UID = {
  [OPERADOR]: "00000000-0000-4000-8000-0000000000a1",
  [OUTRO]: "00000000-0000-4000-8000-0000000000b2",
  [INATIVO]: "00000000-0000-4000-8000-0000000000c3",
  [SEM_PERFIL]: "00000000-0000-4000-8000-0000000000d4",
  [AMANDA]: "00000000-0000-4000-8000-0000000000e5",
  [FERNANDA]: "00000000-0000-4000-8000-0000000000f6",
  [AMANDA_ADM]: "00000000-0000-4000-8000-000000000007",
};

const ESQUEMA = `
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('teste.uid', true), '')::uuid $$;
  create function auth.email() returns text language sql stable
    as $$ select nullif(current_setting('teste.email', true), '') $$;

  create table public.usuarios (email text primary key, ativo boolean default true);
  create function public.usuario_e_gestao() returns boolean language sql stable
    as $$ select lower(coalesce(auth.email(), '')) = any (array['${GESTAO.join("','")}']) $$;

  create table public.alunos (
    id uuid primary key, nome text, telefone text, responsavel_atual_email text,
    status_baixa_pagamento text, status_acionamento text, data_ultimo_acionamento timestamptz,
    data_retorno date, hora_retorno text, retorno_origem text,
    retorno_prioritario boolean default false, retorno_confirmado_em timestamptz,
    nivel_criticidade text, situacao_operacional text, proxima_acao text,
    saldo_vencido numeric, saldo_total numeric, valor_em_aberto numeric, observacao text
  );
  create table public.casos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid,
    status_termo text default 'Sem termo', termo_status_validacao text, criticidade text,
    situacao_operacional text, proxima_acao_automatica text, proximo_vencimento date,
    parcela_a_vencer numeric, parcelas_vencidas int, saldo_vencido numeric, saldo_total numeric,
    data_retorno date, quitado_em timestamptz, caso_atualizado_em timestamptz
  );
  create table public.acordos (id uuid primary key, aluno_id uuid, status text, criado_em timestamptz default now());
  create table public.pagamentos (aluno_id uuid, data_pagamento date);
  create table public.parcelas (
    id uuid primary key default gen_random_uuid(), acordo_id uuid, numero int, valor numeric,
    vencimento date, status text, is_entrada boolean
  );
  create table public.acordos_titulos (
    id uuid primary key default gen_random_uuid(), aluno_id uuid, situacao text, status text,
    tipo_boleto text, vencimento date, valor_cobranca_ajustado numeric, saldo_corrigido numeric,
    valor_em_aberto numeric, valor_original numeric, origem_encerramento text,
    origem_encerramento_em timestamptz, atualizado_em timestamptz, created_at timestamptz default now()
  );
  create table public.acordo_titulo_vinculo (titulo_id uuid, acordo_id uuid, ativo boolean default true);
  create table public.solicitacoes_confirmacao_pagamento (aluno_id text, status text);
  create table public.calibragem_parametros (chave text primary key, valor jsonb);
  create table public.retorno_acordo_auto (
    aluno_id uuid, proximo_vencimento date, data_retorno date, valor numeric, lote text,
    gerado_em timestamptz default now(), unique (aluno_id, proximo_vencimento)
  );
  create table public.auditoria (id uuid primary key default gen_random_uuid(), usuario text, acao text, tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamp default now());
  create table public.aluno_movimentacoes (tipo text, descricao text);
  create function public.titulo_superado_por_acordo(uuid, date) returns boolean language sql as $$ select false $$;
  create function public.calibragem_nivel_criticidade(int, int, numeric, boolean, boolean, jsonb)
    returns text language sql as $$ select 'ATENCAO'::text $$;
  create function public.parcela_viva(text) returns boolean language sql immutable
    as $$ select upper(coalesce($1,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO') $$;
  create function public.fmt_brl(numeric) returns text language sql as $$ select 'R$ ' || $1::text $$;
  create function public.dia_util_anterior_ou_igual(date) returns date language sql as $$ select $1 $$;
`;

const como = (db, email) =>
  db.exec(
    email
      ? `select set_config('teste.email', '${email}', false), set_config('teste.uid', '${UID[email]}', false);`
      : `select set_config('teste.email', '', false), set_config('teste.uid', '', false);`
  );

async function montar({ comPacote, soParte1 = false }) {
  const db = new PGlite();
  await db.exec(ESQUEMA);
  await db.exec(
    `insert into public.usuarios (email, ativo) values
       ('${OPERADOR}', true), ('${OUTRO}', true), ('${INATIVO}', false),
       ('${AMANDA}', true), ('${FERNANDA}', true), ('${AMANDA_ADM}', true);`
  );
  await db.exec(AGENDA_CONFIRMADO);
  await db.exec(CORPO_VIVO);
  await db.exec("grant execute on function public.recalcular_situacao_aluno(uuid, text) to authenticated;");
  if (comPacote) {
    await db.exec(P1_PEND);
    if (!soParte1) await db.exec(P2_PEND);
  }
  for (const [id, nome, dono] of [
    [ALUNA, "Aluna Ficticia Um", OPERADOR],
    [OUTRA, "Aluna Ficticia Dois", OUTRO],
  ]) {
    await db.query(
      `insert into public.alunos (id, nome, telefone, responsavel_atual_email, data_ultimo_acionamento, observacao)
       values ($1, $2, '(51) 90000-0000', $3, now() - interval '3 days', 'obs inicial')`,
      [id, nome, dono]
    );
    await db.query("insert into public.casos (aluno_id) values ($1)", [id]);
    await db.query(
      `insert into public.acordos_titulos (aluno_id, situacao, status, tipo_boleto, vencimento, valor_original)
       values ($1, 'ABERTO', 'aberta', 'Mensalidade', current_date - 40, 500)`,
      [id]
    );
  }
  await como(db, null);
  await recalcularTodos(db);
  return db;
}

const recalcularTodos = (db) =>
  db.exec("select public.recalcular_situacao_aluno(id, 'virada_teste') from public.alunos;");

const md5Corpo = async (db) =>
  (await db.query("select md5(prosrc) as m from pg_proc where oid = 'public.recalcular_situacao_aluno(uuid,text)'::regprocedure")).rows[0].m;

const linha = async (db, id) =>
  (
    await db.query(
      `select data_retorno::text as data_retorno, hora_retorno, retorno_origem, retorno_prioritario,
              retorno_confirmado_em::text as confirmado, observacao
         from public.alunos where id = $1`,
      [id]
    )
  ).rows[0];

// Tela: agendamento humano EXPLICITO (botao Reagendar -> RPC).
async function reagendar(db, email, id, dias, hora) {
  await como(db, email);
  await db.query("select public.agenda_reagendar_retorno($1, current_date + $2::int, $3, false)", [id, dias, hora]);
  await como(db, null);
}

// Tela: "Ja falei" -> RPC de confirmacao (ja existente, nao muda).
async function jaFalei(db, email, id) {
  await como(db, email);
  await db.query("select public.agenda_confirmar_retorno($1, true)", [id]);
  await como(db, null);
}

// Gravacao comum da ficha (observacao) ou automatica (data, sem RPC).
async function gravacaoComum(db, id) {
  await db.query("update public.alunos set observacao = 'obs nova' where id = $1", [id]);
}
async function gravacaoAutomatica(db, id, dias) {
  await db.query("update public.alunos set data_retorno = current_date + $2::int, retorno_origem = 'AUTOMATICO' where id = $1", [id, dias]);
}

async function amanhece(db) {
  await db.exec(`
    alter table public.alunos disable trigger user;
    update public.alunos
       set data_retorno = data_retorno - 1,
           data_ultimo_acionamento = data_ultimo_acionamento - interval '1 day',
           retorno_confirmado_em = retorno_confirmado_em - interval '1 day';
    update public.acordos_titulos set vencimento = vencimento - 1;
    alter table public.alunos enable trigger user;
  `);
  await como(db, null);
  await recalcularTodos(db);
}

async function avisoHoje(db, horaAgora) {
  const { rows } = await db.query(
    `select id::text as id, nome, telefone, responsavel_atual_email,
            data_retorno::text as data_retorno, hora_retorno, retorno_origem, retorno_prioritario,
            retorno_confirmado_em::text as retorno_confirmado_em, current_date::text as hoje
       from public.alunos order by nome`
  );
  const hoje = rows[0].hoje;
  const semana = retornosAgendados(rows, hoje, JANELA_RETORNOS_DIAS);
  return retornoParaAvisar(semana, { hoje, horaAgora, silenciados: new Map() });
}

describe("cadeia de md5 e rollback", () => {
  it("o fixture e o corpo vivo; a parte 1 leva a 03dacc0a; a parte 2 (leitura travada) leva a c3e38ac0", async () => {
    const i = CORPO_VIVO.indexOf("AS $function$") + "AS $function$".length;
    const prosrc = CORPO_VIVO.slice(i, CORPO_VIVO.lastIndexOf("$function$"));
    expect(md5(prosrc)).toBe(MD5_VIVO);
    const so1 = await montar({ comPacote: true, soParte1: true });
    expect(await md5Corpo(so1)).toBe(MD5_PARTE1);
    const pacote = await montar({ comPacote: true });
    expect(await md5Corpo(pacote)).toBe(MD5_FINAL);
  });

  it("o rollback volta ao corpo vivo e recria o gatilho de zeragem", async () => {
    const db = await montar({ comPacote: false });
    await db.exec(P1_PEND);
    await db.exec(P2_PEND);
    // cadeia: vivo -> 03dacc0a (P1) -> c3e38ac0 (P2) -> 03dacc0a (rollback P2) -> vivo (rollback P1)
    expect(await md5Corpo(db)).toBe(MD5_FINAL);
    await db.exec(P2_ROLL);
    expect(await md5Corpo(db)).toBe(MD5_PARTE1);
    await db.exec(P1_ROLL);
    expect(await md5Corpo(db)).toBe(MD5_VIVO);
    const r = await db.query("select count(*)::int as n from pg_trigger where tgrelid = 'public.alunos'::regclass and tgname = 'trg_aluno_reset_retorno_confirmado'");
    expect(r.rows[0].n).toBe(1);
  });

  it("recusa a parte 1 se o corpo nao for o lido em producao", async () => {
    const db = await montar({ comPacote: false });
    await db.exec(CORPO_VIVO.replace("v_retorno := hoje;", "v_retorno := hoje + 0;"));
    await expect(db.exec(P1_PEND)).rejects.toThrow(/CORPO INESPERADO|ANCORA NAO BATE/);
    await db.exec("rollback;");
  });
});

describe("so o reagendamento humano explicito zera 'Ja falei'", () => {
  it("sem o pacote, o 'Ja falei' some quando a data muda e o aviso volta (falha se a correcao sumir)", async () => {
    const db = await montar({ comPacote: false });
    await db.query("update public.alunos set data_retorno = current_date, hora_retorno = '14:30', retorno_origem = 'OPERADOR' where id = $1", [ALUNA]);
    await jaFalei(db, OPERADOR, ALUNA);
    await db.query("update public.alunos set data_retorno = current_date + 0 where id = $1", [ALUNA]);
    await db.query("update public.alunos set data_retorno = current_date + 1 where id = $1", [ALUNA]);
    expect((await linha(db, ALUNA)).confirmado).toBeNull();
  });

  it("'Ja falei' encerra o aviso e a virada nao o reabre", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "14:30");
    expect((await avisoHoje(db, "14:30"))?.id).toBe(ALUNA);
    await jaFalei(db, OPERADOR, ALUNA);
    expect(await avisoHoje(db, "14:31")).toBeNull();
    for (let dia = 1; dia <= 3; dia += 1) {
      await amanhece(db);
      expect(await avisoHoje(db, "14:30")).toBeNull();
    }
  });

  it("gravacao comum da ficha (observacao) preserva a confirmacao", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "14:30");
    await jaFalei(db, OPERADOR, ALUNA);
    const antes = (await linha(db, ALUNA)).confirmado;
    expect(antes).not.toBeNull();
    await gravacaoComum(db, ALUNA);
    const depois = await linha(db, ALUNA);
    expect(depois.confirmado).toBe(antes);
    expect(depois.observacao).toBe("obs nova");
  });

  it("gravacao automatica que muda a data (tabulacao, lote) preserva a confirmacao", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "14:30");
    await jaFalei(db, OPERADOR, ALUNA);
    const antes = (await linha(db, ALUNA)).confirmado;
    await gravacaoAutomatica(db, ALUNA, 5);
    expect((await linha(db, ALUNA)).confirmado).toBe(antes);
  });

  it("reagendar na MESMA data e hora, depois do 'Ja falei', nasce pendente e reativa o aviso", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    await jaFalei(db, OPERADOR, ALUNA);
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    const l = await linha(db, ALUNA);
    expect(`${l.retorno_origem}:${l.hora_retorno}:${l.confirmado}`).toBe("OPERADOR:10:00:null");
    await amanhece(db);
    expect((await avisoHoje(db, "10:00"))?.id).toBe(ALUNA);
  });

  it("reagendar em outra data nasce pendente", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    await jaFalei(db, OPERADOR, ALUNA);
    await reagendar(db, OPERADOR, ALUNA, 2, "08:00");
    expect((await linha(db, ALUNA)).confirmado).toBeNull();
  });

  it("retorno NAO tratado continua como combinado: a virada muda so a data", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "09:15");
    await amanhece(db);
    const l = await linha(db, ALUNA);
    expect(`${l.retorno_origem}:${l.hora_retorno}:${l.confirmado}`).toBe("OPERADOR:09:15:null");
    expect((await avisoHoje(db, "09:15"))?.id).toBe(ALUNA);
  });
});

describe("permissoes por perfil (RPC de reagendamento)", () => {
  it("anon (sem sessao) e recusado e nada muda", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    const antes = await linha(db, ALUNA);
    await como(db, null);
    await expect(db.query("select public.agenda_reagendar_retorno($1, current_date, '16:00', false)", [ALUNA])).rejects.toThrow(/Sem sessao/);
    expect(await linha(db, ALUNA)).toEqual(antes);
  });

  it("authenticated sem perfil (fora de usuarios) e recusado", async () => {
    const db = await montar({ comPacote: true });
    await db.query("select set_config('teste.email', $1, false), set_config('teste.uid', $2, false)", [SEM_PERFIL, UID[OPERADOR]]);
    await expect(db.query("select public.agenda_reagendar_retorno($1, current_date, '16:00', false)", [ALUNA])).rejects.toThrow(/inativo ou sem cadastro/);
    await como(db, null);
  });

  it("operador INATIVO e dono do caso e recusado", async () => {
    const db = await montar({ comPacote: true });
    await db.query("insert into public.alunos (id, nome, responsavel_atual_email) values ('a1000000-0000-4000-8000-0000000000ff', 'X', $1)", [INATIVO]);
    await como(db, INATIVO);
    await expect(db.query("select public.agenda_reagendar_retorno('a1000000-0000-4000-8000-0000000000ff', current_date, null, false)")).rejects.toThrow(/inativo ou sem cadastro/);
    await como(db, null);
  });

  it("operador NAO dono e recusado (isolamento de carteira) e nada muda", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    const antes = await linha(db, ALUNA);
    await como(db, OUTRO);
    await expect(db.query("select public.agenda_reagendar_retorno($1, current_date, '16:00', false)", [ALUNA])).rejects.toThrow(/Sem permissao para reagendar/);
    await como(db, null);
    expect(await linha(db, ALUNA)).toEqual(antes);
  });

  it("operador DONO reagenda o proprio caso", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "16:00");
    expect((await linha(db, ALUNA)).hora_retorno).toBe("16:00");
  });

  it("Amanda, Fernanda e Amanda ADM reagendam caso alheio pelo gate de gestao existente", async () => {
    for (const gestor of GESTAO) {
      const db = await montar({ comPacote: true });
      await reagendar(db, gestor, OUTRA, 0, "17:00");
      expect((await linha(db, OUTRA)).hora_retorno).toBe("17:00");
    }
  });

  it("data nula e recusada, sem gravar", async () => {
    const db = await montar({ comPacote: true });
    await como(db, OPERADOR);
    await expect(db.query("select public.agenda_reagendar_retorno($1, null, null, false)", [ALUNA])).rejects.toThrow(/Informe a data/);
    await como(db, null);
  });

  it("ACL: anon nao executa a RPC; authenticated executa", async () => {
    const db = await montar({ comPacote: true });
    const r = await db.query(
      "select has_function_privilege('anon', 'public.agenda_reagendar_retorno(uuid,date,text,boolean)', 'EXECUTE') as anon, has_function_privilege('authenticated', 'public.agenda_reagendar_retorno(uuid,date,text,boolean)', 'EXECUTE') as auth"
    );
    expect(r.rows[0].anon).toBe(false);
    expect(r.rows[0].auth).toBe(true);
  });
});

describe("triggers compartilhados continuam funcionando", () => {
  it("gatilho de pagamento executado pela sessao de OUTRO operador recalcula sem ser barrado", async () => {
    const db = await montar({ comPacote: true });
    await db.exec(`
      create table public.pagamentos_teste (aluno_id uuid);
      create function public.teste_recalc_no_gatilho() returns trigger language plpgsql security definer set search_path to 'public' as $$
      begin perform public.recalcular_situacao_aluno(new.aluno_id, 'gatilho_pagamento'); return new; end $$;
      create trigger trg_teste_recalc after insert on public.pagamentos_teste for each row execute function public.teste_recalc_no_gatilho();
      grant insert on public.pagamentos_teste to authenticated;
      grant execute on function public.teste_recalc_no_gatilho() to authenticated;
    `);
    await como(db, OUTRO);
    await db.query("insert into public.pagamentos_teste (aluno_id) values ($1)", [ALUNA]);
    await como(db, null);
  });

  it("erro dentro de gatilho NAO e engolido: a RPC recusada derruba a instrucao que a chamou", async () => {
    const db = await montar({ comPacote: true });
    await db.exec(`
      create table public.agenda_teste (aluno_id uuid);
      create function public.teste_reagenda_no_gatilho() returns trigger language plpgsql security definer set search_path to 'public' as $$
      begin perform public.agenda_reagendar_retorno(new.aluno_id, current_date, null, false); return new; end $$;
      create trigger trg_teste_reagenda after insert on public.agenda_teste for each row execute function public.teste_reagenda_no_gatilho();
      grant insert on public.agenda_teste to authenticated;
      grant execute on function public.teste_reagenda_no_gatilho() to authenticated;
    `);
    await como(db, OUTRO);
    await expect(db.query("insert into public.agenda_teste (aluno_id) values ($1)", [ALUNA])).rejects.toThrow(/Sem permissao para reagendar/);
    await como(db, null);
  });
});

describe("backup por id", () => {
  it("tabela com RLS ligada, sem politica e sem grant para anon nem authenticated", async () => {
    const db = await montar({ comPacote: true });
    const r = await db.query(
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policies where tablename = 'retorno_backup_20261114') as politicas,
              has_table_privilege('anon', 'public.retorno_backup_20261114', 'SELECT') as anon_le,
              has_table_privilege('authenticated', 'public.retorno_backup_20261114', 'SELECT') as auth_le
         from pg_class c where c.oid = 'public.retorno_backup_20261114'::regclass`
    );
    expect(r.rows[0].rls).toBe(true);
    expect(r.rows[0].politicas).toBe(0);
    expect(r.rows[0].anon_le).toBe(false);
    expect(r.rows[0].auth_le).toBe(false);
  });

  it("gravacao idempotente: reaplicar o bloco de backup nao duplica", async () => {
    const db = await montar({ comPacote: true });
    const n1 = (await db.query("select count(*)::int as n from public.retorno_backup_20261114")).rows[0].n;
    await db.exec(P2_PEND);
    const n2 = (await db.query("select count(*)::int as n from public.retorno_backup_20261114")).rows[0].n;
    expect(n2).toBe(n1);
  });

  it("restauracao so altera os ids listados e recusa id sem snapshot", async () => {
    const db = await montar({ comPacote: false });
    await db.query("update public.alunos set data_retorno = current_date, hora_retorno = '10:00', retorno_origem = 'OPERADOR' where id = $1", [ALUNA]);
    await db.query("update public.alunos set data_retorno = current_date, hora_retorno = '11:00', retorno_origem = 'OPERADOR' where id = $1", [OUTRA]);
    await db.exec(P1_PEND);
    await db.exec(P2_PEND);
    // altera depois do snapshot
    await db.query("update public.alunos set hora_retorno = '23:00' where id = $1", [ALUNA]);
    await db.query("update public.alunos set hora_retorno = '23:00' where id = $1", [OUTRA]);
    const ids = `array['${ALUNA}']::uuid[]`;
    await db.exec(RESTAURA_PEND.replace("array[]::uuid[];   -- PREENCHER com os ids aprovados", `${ids};`));
    expect((await linha(db, ALUNA)).hora_retorno).toBe("10:00");
    expect((await linha(db, OUTRA)).hora_retorno).toBe("23:00");
    await db.exec("rollback;");
    await expect(
      db.exec(RESTAURA_PEND.replace("array[]::uuid[];   -- PREENCHER com os ids aprovados", "array['a1000000-0000-4000-8000-0000000000ee']::uuid[];"))
    ).rejects.toThrow(/RESTAURACAO RECUSADA/);
  });
});

// ---------------------------------------------------------------------------
// PAPEIS NAO PRIVILEGIADOS: a autorizacao da RPC e provada trocando de role
// (SET ROLE anon / authenticated) com claims, e NAO como superuser. O ACL
// (EXECUTE) e checado pelo proprio banco no papel; a regra de negocio roda na
// RPC (security definer), com auth.uid/auth.email vindos das claims do teste.
// ---------------------------------------------------------------------------
async function comPapel(db, role, quem, fn) {
  await como(db, quem);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await como(db, null);
  }
}
const CHAMADA_RPC = "select public.agenda_reagendar_retorno($1, current_date + 1, '18:00', false)";

describe("autorizacao da RPC com papeis nao privilegiados", () => {
  it("anon (SET ROLE anon) nao tem EXECUTE: o banco recusa e nada muda", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    const antes = await linha(db, ALUNA);
    await expect(comPapel(db, "anon", null, () => db.query(CHAMADA_RPC, [ALUNA])))
      .rejects.toThrow(/permission denied/i);
    expect(await linha(db, ALUNA)).toEqual(antes);
  });

  it("authenticated sem claims (sem sessao) e recusado", async () => {
    const db = await montar({ comPacote: true });
    await expect(comPapel(db, "authenticated", null, () => db.query(CHAMADA_RPC, [ALUNA])))
      .rejects.toThrow(/Sem sessao/);
  });

  it("authenticated sem perfil em usuarios e recusado", async () => {
    const db = await montar({ comPacote: true });
    await expect(comPapel(db, "authenticated", SEM_PERFIL, () => db.query(CHAMADA_RPC, [ALUNA])))
      .rejects.toThrow(/inativo ou sem cadastro/);
  });

  it("authenticated com perfil INATIVO e recusado", async () => {
    const db = await montar({ comPacote: true });
    await expect(comPapel(db, "authenticated", INATIVO, () => db.query(CHAMADA_RPC, [ALUNA])))
      .rejects.toThrow(/inativo ou sem cadastro/);
  });

  it("operador NAO dono (SET ROLE authenticated) e recusado e nada muda", async () => {
    const db = await montar({ comPacote: true });
    await reagendar(db, OPERADOR, ALUNA, 0, "10:00");
    const antes = await linha(db, ALUNA);
    await expect(comPapel(db, "authenticated", OUTRO, () => db.query(CHAMADA_RPC, [ALUNA])))
      .rejects.toThrow(/Sem permissao para reagendar/);
    expect(await linha(db, ALUNA)).toEqual(antes);
  });

  it("operador DONO (SET ROLE authenticated) reagenda o proprio caso", async () => {
    const db = await montar({ comPacote: true });
    await comPapel(db, "authenticated", OPERADOR, () => db.query(CHAMADA_RPC, [ALUNA]));
    expect((await linha(db, ALUNA)).hora_retorno).toBe("18:00");
  });

  it("Amanda, Fernanda e Amanda ADM (SET ROLE authenticated) reagendam caso alheio, cada uma com seu perfil", async () => {
    for (const gestor of GESTAO) {
      const db = await montar({ comPacote: true });
      await comPapel(db, "authenticated", gestor, () => db.query(CHAMADA_RPC, [OUTRA]));
      expect((await linha(db, OUTRA)).hora_retorno).toBe("18:00");
    }
  });
});

// ---------------------------------------------------------------------------
// REVOGACAO DE EXECUTE DE AUTHENTICATED NO RECALCULO (corpo real + chamador real)
// Medido em producao (catalogo, 15/11/2026): public/anon sem EXECUTE; authenticated
// e service_role com EXECUTE; todos os chamadores sao SECURITY DEFINER de dono
// postgres. Aqui: o corpo real, os gatilhos reais da migration de origem, e o
// rollback restaurando a ACL medida. Os gatilhos reais ENGOLEM erro (when others),
// entao o teste confere o EFEITO no caso, nao so a ausencia de erro.
// ---------------------------------------------------------------------------
const MIG_RECALC = lerRaiz("supabase/migrations/20260801120000_recalcular_situacao_aluno.sql");
const TRIGGERS_REAIS = MIG_RECALC.slice(
  MIG_RECALC.indexOf("create or replace function public._trg_recalc_por_parcela()"),
  MIG_RECALC.indexOf("drop trigger if exists trg_recalc_baixa")
);
const ASSIN_RECALC = "public.recalcular_situacao_aluno(uuid,text)";

async function privilegiosRecalc(db) {
  const r = await db.query(`
    select
      has_function_privilege('anon', '${ASSIN_RECALC}', 'EXECUTE') as anon,
      has_function_privilege('authenticated', '${ASSIN_RECALC}', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', '${ASSIN_RECALC}', 'EXECUTE') as service_role,
      exists (select 1 from pg_proc p, aclexplode(p.proacl) a
               where p.oid = '${ASSIN_RECALC}'::regprocedure and a.grantee = 0
                 and a.privilege_type = 'EXECUTE') as public`);
  return r.rows[0];
}

describe("revogacao de authenticated no recalculo: corpo real e chamadores reais", () => {
  it("apos o pacote: authenticated sem EXECUTE; service_role com; anon e public sem", async () => {
    const db = await montar({ comPacote: true });
    expect(await privilegiosRecalc(db)).toEqual({
      anon: false, authenticated: false, service_role: true, public: false,
    });
  });

  it("chamada DIRETA ao recalculo por authenticated e recusada e nada muda", async () => {
    const db = await montar({ comPacote: true });
    const antes = await linha(db, ALUNA);
    await expect(
      comPapel(db, "authenticated", OPERADOR, () =>
        db.query("select public.recalcular_situacao_aluno($1, 'teste_direto')", [ALUNA]))
    ).rejects.toThrow(/permission denied/i);
    expect(await linha(db, ALUNA)).toEqual(antes);
  });

  it("gatilho REAL de parcelas (SECURITY DEFINER) recalcula para authenticated: o efeito aparece no caso", async () => {
    const db = await montar({ comPacote: true });
    await db.exec(TRIGGERS_REAIS);
    const ac = await db.query(
      "insert into public.acordos (id, aluno_id, status) values (gen_random_uuid(), $1, 'ativo') returning id",
      [ALUNA]
    );
    const acordoId = ac.rows[0].id;
    await db.exec("grant insert on public.parcelas to authenticated;");
    const saldo = async () =>
      Number((await db.query("select saldo_total from public.casos where aluno_id = $1", [ALUNA])).rows[0].saldo_total);
    const s0 = await saldo();
    await comPapel(db, "authenticated", OPERADOR, () =>
      db.query(
        "insert into public.parcelas (acordo_id, numero, valor, vencimento, status, is_entrada) values ($1, 1, 300, current_date - 5, 'ABERTA', false)",
        [acordoId]
      )
    );
    expect(await saldo()).toBeCloseTo(s0 + 300, 2);
  });

  it("rollback da secao E restaura a ACL de origem medida (authenticated volta; public e anon nao)", async () => {
    const db = await montar({ comPacote: true });
    expect((await privilegiosRecalc(db)).authenticated).toBe(false);
    await db.exec(P2_ROLL);
    expect(await privilegiosRecalc(db)).toEqual({
      anon: false, authenticated: true, service_role: true, public: false,
    });
  });
});

// CONTRATO INDEPENDENTE DA TELA: mudanca comum de data (UPDATE direto, como authenticated,
// sem a RPC) preserva "Ja falei". So agenda_reagendar_retorno zera a confirmacao.
describe("contrato de 'Ja falei': imposto no banco, independente da tela", () => {
  it("UPDATE direto de data_retorno por authenticated preserva retorno_confirmado_em", async () => {
    const db = await montar({ comPacote: true });
    await db.exec("grant select, update on public.alunos to authenticated;");
    await jaFalei(db, OPERADOR, ALUNA);
    const antes = await linha(db, ALUNA);
    expect(antes.confirmado).not.toBeNull();
    await comPapel(db, "authenticated", OPERADOR, () =>
      db.query("update public.alunos set data_retorno = current_date + 9 where id = $1", [ALUNA])
    );
    const depois = await linha(db, ALUNA);
    expect(depois.data_retorno).not.toBe(antes.data_retorno);
    expect(depois.confirmado).toBe(antes.confirmado);
  });

  it("so a RPC zera: reagendar na MESMA data e hora zera a confirmacao", async () => {
    const db = await montar({ comPacote: true });
    await jaFalei(db, OPERADOR, ALUNA);
    const antes = await linha(db, ALUNA);
    const { d } = (await db.query("select (data_retorno - current_date)::int as d from public.alunos where id = $1", [ALUNA])).rows[0];
    await reagendar(db, OPERADOR, ALUNA, d, antes.hora_retorno ?? null);
    expect((await linha(db, ALUNA)).confirmado).toBeNull();
  });
});

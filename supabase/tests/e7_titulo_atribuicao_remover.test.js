// E7: RETIRAR A ATRIBUIÇÃO DE UMA MENSALIDADE QUE O ACORDO NÃO PAGOU --
// COMPORTAMENTO, não estrutura.
//
// Roda num PostgreSQL real (PGlite). O motor de decisão NÃO é dublê: as duas
// migrations reais que definem `titulo_reavaliar` são carregadas do disco,
//
//   20260922265000  a regra de 22/09 (acordo cancelado nao reabre)
//   20260925123852  a regra de 25/09 (sem pagamento na cadeia, reabre)
//   20261026190000  a E7 (aguardando_aprovacao/, NAO aplicada em producao)
//
// e o `md5(prosrc)` de cada objeto que importa é conferido contra o corpo de
// PRODUÇÃO medido em 26/10/2026. Se produção mudar, estes testes falham --
// que é o sinal certo, não um incômodo.
//
// Os três gatilhos que vigiam `acordos_titulos` e `acordo_titulo_vinculo` são
// cópias LITERAIS do `prosrc` de produção (mesmo md5), porque as migrations que
// os definem trazem um grafo de dependências grande demais para esta bancada:
//   _titulo_situacao_e_status_coerentes     (BEFORE -- coage o par)
//   titulo_liquidado_na_origem_e_terminal   (BEFORE -- liquidação oficial)
//   titulo_situacao_por_vinculo             (AFTER  -- chama o motor)
// `desvincular_titulos_acordo` também é cópia literal, para o bloco que prova
// o defeito da porta antiga.
//
// SÃO DUBLÊS, e nada mais: `recalcular_situacao_aluno` (registra a chamada, para
// provar que a E7 delega em vez de recalcular à mão), `liberar_caso_por_evento`
// e `crm_usuario_pode_quitar_baixar`. `usuario_e_gestao`, `fmt_brl` e
// `parcela_viva` são cópias literais de produção, sem md5 declarado.
//
// NENHUM DADO REAL. O cenário principal reproduz a FORMA e os NÚMEROS do caso
// da Rayssa Lourenço Santiago (acordo 5696 / ULBRA 74229, títulos 4510929 e
// 4510930), com ids sintéticos. A aluna real não é tocada por este arquivo.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");

const REGRA_22_09 = ler("supabase/migrations/20260922265000_acordo_cancelado_nao_reabre_mensalidade_negociada.sql");
const REGRA_25_09 = ler("supabase/migrations/20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade.sql");
const E7 = ler("supabase/aguardando_aprovacao/20261026190000_e7_titulo_atribuicao_remover.sql.pendente");
const E7_ROLLBACK = ler("supabase/aguardando_aprovacao/20261026190000_e7_titulo_atribuicao_remover.rollback.sql");

// Corpos de PRODUÇÃO em 26/10/2026 (projeto ahattpqrjmhkzsmnbdzs).
const MD5_PROD = {
  titulo_reavaliar: "a86ab9bf86267fbf4c273a916b072cb7",
  titulo_reabrir_quitacao_por_acordo: "85e9b01e88aa8ffd881a5373c92f0f82",
  _titulo_situacao_e_status_coerentes: "e406ed8f93458fc7ef33b53543f3baef",
  titulo_liquidado_na_origem_e_terminal: "a173c24547b5c857b131aa845f7479de",
  titulo_situacao_por_vinculo: "597e619bd709b70de3772d86f19cf8c8",
  desvincular_titulos_acordo: "ebd07b0ec54e64f9ab685928988cb9a5",
};

const GESTAO = `{"email":"amanda.seibel@aelbra.com.br"}`;
const OPERADOR = `{"email":"cobranca06@aelbra.com.br"}`;
const SERVICE = `{"role":"service_role"}`;

// Os números do caso-prova, ao centavo.
const VALOR_MENSALIDADE = "2869.73";
const VALOR_ACORDO = "3313.09";

async function um(db, sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}
// `count(*)` volta número (não BigInt) neste caminho do PGlite: comparar com
// 0n falharia por TIPO. Converter sempre.
const n = (v) => Number(v);

const BANCADA = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.email() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'email' $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role' $$;

create table public.alunos (id uuid primary key default gen_random_uuid(), nome text,
  saldo_total numeric default 0, saldo_vencido numeric default 0,
  status_jornada text, status_atual text, status_acionamento text);

create table public.casos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  encerrado_operacional boolean default false, situacao_operacional text, saldo_total numeric);

create table public.acordos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  status text default 'ATIVO', valor_total numeric, qtd_parcelas int default 1, saldo numeric,
  numero_acordo bigint, numero_ulbra text, motivo_ajuste text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now());

create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  documento text, valor_original numeric, saldo_corrigido numeric, valor_em_aberto numeric,
  valor_cobranca_ajustado numeric,
  situacao text, status text, tipo_boleto text default 'Cursos de Graduação Presencial',
  acordo_id uuid, motivo_ajuste text,
  origem_liquidacao text, origem_liquidacao_ref text, origem_liquidacao_em timestamptz,
  origem_encerramento text, origem_encerramento_ref text, origem_encerramento_em timestamptz,
  vinculado_em timestamptz, vinculado_por text,
  created_at timestamp default now(), atualizado_em timestamptz default now());

create table public.acordo_titulo_vinculo (id uuid primary key default gen_random_uuid(),
  acordo_id uuid, titulo_id uuid, ativo boolean default true, vinculado_por text, origem text,
  motivo_desvinculo text, criado_em timestamptz default clock_timestamp());
create unique index ux_titulo_vinculo_ativo on public.acordo_titulo_vinculo (titulo_id) where ativo;

create table public.parcelas (id uuid primary key default gen_random_uuid(), acordo_id uuid,
  numero int default 1, status text default 'A_VENCER', valor numeric, vencimento date,
  boleto text, honorarios numeric, titulos_origem text, is_entrada boolean default false,
  origem_baixa text, origem_baixa_ref text, origem_baixa_em timestamptz,
  renegociada_em timestamptz, renegociada_no_acordo_id uuid, solicitacao_confirmacao_id uuid,
  pago_em timestamptz, confirmado_por_email text, observacao text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now());

create table public.solicitacoes_confirmacao_pagamento (id uuid primary key default gen_random_uuid(),
  aluno_id text, status text);

create table public.aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text,
  descricao text, status_anterior text, status_novo text, registrado_por_nome text,
  registrado_por_email text, registrado_em timestamptz, valor_movimentacao numeric);

create table public.pagamentos (id uuid primary key default gen_random_uuid(), aluno_id uuid,
  data_pagamento date, valor_pago numeric, titulo_numero text, numero_parcela_completo text,
  valor_honorario numeric, status_conciliacao text, operador_email text);

create table public.baixas_pagamento (id uuid primary key default gen_random_uuid(), acordo_id uuid,
  parcela_id uuid, baixado_por_email text, baixado_em timestamptz, devolvido_em timestamptz);

create table public.auditoria (id bigserial primary key, usuario text, acao text,
  tabela_afetada text, registro_id uuid, detalhes jsonb, created_at timestamp default now());

create table public.mensalidade_reconciliacao_log (id bigserial primary key, lote text not null,
  titulo_id uuid not null, aluno_id uuid, acordo_id uuid, numero_acordo bigint, documento text,
  valor_original numeric, situacao_antes text, status_antes text, situacao_depois text,
  status_depois text, motivo text, executado_por text, executado_em timestamptz default now());

-- cópias LITERAIS de produção (helpers)
create or replace function public.fmt_brl(p numeric) returns text language sql immutable as $body$
  select 'R$ ' || translate(to_char(round(coalesce(p,0),2),'FM999G999G999G990D00'), '.,', ',.');
$body$;

create or replace function public.usuario_e_gestao() returns boolean language sql stable as $body$
  select lower(coalesce(auth.jwt()->>'email','')) in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$body$;

create table public.usuarios (id uuid primary key default gen_random_uuid(), email text,
  perfil text, ativo boolean default true);

create or replace function public.usuario_e_diretoria() returns boolean language sql stable as $body$
  select exists (
    select 1 from public.usuarios u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and u.ativo is true
      and u.perfil = 'diretoria'
  );
$body$;

create or replace function public.parcela_viva(p_status text) returns boolean language sql immutable as $body$
  select upper(coalesce(p_status, '')) not in (
    -- pagamento real (regra 1: so aqui entra dinheiro)
    'PAGO', 'PAGA',
    -- saida por cancelamento/estorno
    'CANCELADA', 'CANCELADO', 'ESTORNADA', 'ESTORNADO',
    -- regra 2: saiu definitivamente da nossa responsabilidade, SEM pagamento
    'DEVOLVIDA',
    -- regra 3: cobranca suspensa temporariamente, SEM pagamento
    'SUSPENSA'
  );
$body$;

-- DUBLÊS
create table public._chamadas_recalcular (aluno_id uuid, lote text, registrado_em timestamptz default clock_timestamp());
create or replace function public.recalcular_situacao_aluno(p_aluno_id uuid, p_lote text)
returns jsonb language plpgsql as $body$
begin
  insert into public._chamadas_recalcular(aluno_id, lote) values (p_aluno_id, p_lote);
  return jsonb_build_object('duble', true);
end;
$body$;

create table public._chamadas_liberar_evento (aluno_id uuid, evento text);
create or replace function public.liberar_caso_por_evento(p_aluno_id uuid, p_evento text,
  p_valor_pago numeric default null, p_data_pagamento date default null)
returns void language plpgsql as $body$
begin
  insert into public._chamadas_liberar_evento(aluno_id, evento) values (p_aluno_id, p_evento);
end;
$body$;

create or replace function public.crm_usuario_pode_quitar_baixar() returns boolean language sql stable as $body$
  select coalesce(public.usuario_e_gestao(), false);
$body$;
`;

// ======================= CÓPIAS LITERAIS DE PRODUÇÃO ========================
const TRG_COERENTES = `
create or replace function public._titulo_situacao_e_status_coerentes() returns trigger
language plpgsql as $body$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  elsif v_sit = 'DEVOLVIDO' and v_st <> 'devolvido' then
    -- encerrado SEM recuperacao da ReATIVA: a divida volta ao cliente
    new.status := 'devolvido';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$body$;
create trigger trg_titulo_situacao_status_coerentes before insert or update of situacao, status
  on public.acordos_titulos for each row execute function public._titulo_situacao_e_status_coerentes();
`;

const TRG_LIQUIDADO = `
create or replace function public.titulo_liquidado_na_origem_e_terminal() returns trigger
language plpgsql as $body$
declare
  v_tentou text;
begin
  if coalesce(old.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL' then
    return new;
  end if;

  -- As tres marcas nao se apagam: sao a prova de POR QUE o titulo fechou.
  new.origem_liquidacao     := old.origem_liquidacao;
  -- O VELHO VENCE. Nao e coalesce do novo: uma segunda execucao concorrente
  -- chega com OUTRO pagamento em \`new\`, e deixar o novo ganhar reescreveria a
  -- proveniencia -- o titulo passaria a dizer que foi liquidado por um
  -- pagamento que nao foi o que o liquidou. Gravada uma vez, nao troca mais.
  new.origem_liquidacao_ref := coalesce(old.origem_liquidacao_ref, new.origem_liquidacao_ref);
  new.origem_liquidacao_em  := coalesce(old.origem_liquidacao_em,  new.origem_liquidacao_em);

  if coalesce(new.situacao,'') = 'PAGO' and coalesce(new.status,'') = 'quitada' then
    return new;   -- nada a coagir; segue a vida (acordo_id, motivo, etc.)
  end if;

  v_tentou := coalesce(new.situacao,'(null)') || '/' || coalesce(new.status,'(null)');
  new.situacao := 'PAGO';
  new.status   := 'quitada';
  new.motivo_ajuste := coalesce(new.motivo_ajuste,'')
    || case when coalesce(new.motivo_ajuste,'') = '' then '' else ' | ' end
    || 'tentativa de reabrir titulo liquidado na origem (' || v_tentou
    || ') recusada: a divida ja foi concluida pela liquidacao oficial na Prime';

  -- So registra quando REALMENTE impediu alguma coisa -- e raro, e por isso cabe.
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('sistema', 'TITULO_LIQUIDADO_REABERTURA_RECUSADA', 'acordos_titulos', old.id,
          jsonb_build_object('documento', old.documento, 'tentou', v_tentou,
                             'origem_liquidacao_ref', old.origem_liquidacao_ref,
                             'acordo_id_novo', new.acordo_id));
  return new;
end;
$body$;
create trigger trg_titulo_liquidado_na_origem_e_terminal before update
  on public.acordos_titulos for each row execute function public.titulo_liquidado_na_origem_e_terminal();
`;

const TRG_VINCULO = `
create or replace function public.titulo_situacao_por_vinculo() returns trigger
language plpgsql as $body$
declare v_titulo uuid;
begin
  foreach v_titulo in array
    array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null)
  loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
  return coalesce(new, old);
end;
$body$;
create trigger trg_titulo_situacao_por_vinculo after insert or delete or update
  on public.acordo_titulo_vinculo for each row execute function public.titulo_situacao_por_vinculo();
`;

const PORTA_ANTIGA = `
create or replace function public.desvincular_titulos_acordo(p_titulo_ids uuid[]) returns jsonb
language plpgsql security definer set search_path to 'public' as $body$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;

  -- Volta a mensalidade para ABERTO (conta de novo no total do aluno).
  -- ANTES gravava status='vinculada' aqui, produzindo a combinacao incoerente
  -- (ABERTO + vinculada + sem vinculo) que dobrava a divida e travava a tela.
  update public.acordos_titulos
     set acordo_id = null, situacao = 'ABERTO', status = 'em_aberto',
         vinculado_em = null, vinculado_por = null, atualizado_em = now()
   where id = any(p_titulo_ids);
  get diagnostics v_n = row_count;

  delete from public.acordo_titulo_vinculo where titulo_id = any(p_titulo_ids);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'DESVINCULOU_TITULOS_ACORDO', 'acordos_titulos', null,
          jsonb_build_object('qtd', v_n, 'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'desvinculados', v_n);
end;
$body$;
`;

// AS DUAS LINHAS QUE O REPOSITORIO NAO REPRODUZ NESTA BANCADA.
//
// `titulo_reavaliar` e `titulo_reabrir_quitacao_por_acordo` recebem, depois da
// cadeia carregada do disco, duas alteracoes feitas por migrations de PATCH
// ANCORADO (leem `pg_get_functiondef` e trocam um trecho, por isso o corpo
// nunca aparece literal no arquivo):
//
//   20261007211500_parcela_devolvida_suspensa  -> +'DEVOLVIDA','SUSPENSA'
//   20261009090000_titulo_devolvido            -> +'devolvido'
//
// Essas duas migrations abortam numa bancada minima: a primeira exige
// `_acordo_fecha_com_a_ultima_parcela` (que ela tambem patcheia por ancora) e a
// segunda exige `prime_conferencia_encerrar_administrativo(uuid,text)`. Em vez
// de dublar meia dezena de objetos so para chegar a duas linhas, a bancada
// aplica exatamente as mesmas duas substituicoes -- e o teste de md5 prova que
// o resultado e o corpo de PRODUCAO, byte a byte. Se eu errasse a substituicao,
// o md5 denunciaria.
const PATCHES_ANCORADOS = `
do $do$
declare v_def text; v_novo text;
begin
  foreach v_def in array array[
    pg_get_functiondef('public.titulo_reavaliar(uuid)'::regprocedure),
    pg_get_functiondef('public.titulo_reabrir_quitacao_por_acordo(uuid)'::regprocedure)
  ] loop
    v_novo := replace(v_def,
      'not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'')',
      'not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'',''DEVOLVIDA'',''SUSPENSA'')');
    v_novo := replace(v_novo,
      'or lower(coalesce(v_status,'''')) = ''cancelada'' then',
      'or lower(coalesce(v_status,'''')) in (''cancelada'',''devolvido'') then');
    execute v_novo;
  end loop;
end $do$;
`;

const CADEIA_REAL = [
  "supabase/migrations/20261001193805_origem_liquidacao_acordo_quitado.sql",
  "supabase/migrations/20261001193932_quitacao_por_acordo_delega_ao_motor.sql",
  "supabase/migrations/20261001194037_titulo_reabrir_quitacao_por_acordo.sql",
  "supabase/migrations/20261001194211_mensalidade_reconciliar_pago_sem_lastro.sql",
].map(ler);

async function novoBanco({ comE7 = true } = {}) {
  const db = new PGlite();
  await db.exec(BANCADA);
  await db.exec(REGRA_22_09);
  await db.exec(REGRA_25_09);
  for (const m of CADEIA_REAL) await db.exec(m);
  await db.exec(PATCHES_ANCORADOS);
  await db.exec(TRG_COERENTES);
  await db.exec(TRG_LIQUIDADO);
  await db.exec(TRG_VINCULO);
  await db.exec(PORTA_ANTIGA);
  if (comE7) await db.exec(E7);
  return db;
}

// O CENÁRIO DA RAYSSA, em ids sintéticos: um acordo QUITADO que recebeu
// R$ 3.313,09 por UMA mensalidade e carrega DUAS.
async function cenarioRayssa(db, ajustes = {}) {
  const aluno = await um(db, `insert into public.alunos(nome, status_jornada, saldo_total)
    values ('ALUNA DE TESTE', 'QUITADO', 0) returning id`);
  await db.query(`insert into public.casos(aluno_id, encerrado_operacional) values ($1, true)`, [aluno]);

  const acordo = await um(db, `insert into public.acordos(aluno_id, status, valor_total, qtd_parcelas,
      numero_acordo, numero_ulbra) values ($1,'QUITADO',$2,1,5696,'74229') returning id`,
    [aluno, VALOR_ACORDO]);

  await db.query(`insert into public.parcelas(acordo_id, numero, status, valor, vencimento, boleto, honorarios)
    values ($1, 1, 'PAGO', $2, date '2026-10-23', '50742290001', 245.41)`, [acordo, VALOR_ACORDO]);

  await db.query(`insert into public.pagamentos(aluno_id, data_pagamento, valor_pago, titulo_numero,
      numero_parcela_completo, valor_honorario, status_conciliacao, operador_email)
    values ($1, date '2026-10-23', $2, '74229', '50742290001', 245.41, 'BAIXADO', 'cobranca06@aelbra.com.br')`,
    [aluno, VALOR_ACORDO]);

  // agosto: legitimamente negociada e paga no acordo
  const agosto = await um(db, `insert into public.acordos_titulos(aluno_id, documento, valor_original,
      saldo_corrigido, situacao, status, acordo_id, tipo_boleto)
    values ($1,'4510929',$2,$2,'PAGO','quitada',$3,'Cursos de Graduação Presencial') returning id`,
    [aluno, VALOR_MENSALIDADE, acordo]);

  // setembro: varrida para dentro do acordo, sem lastro
  const setembro = await um(db, `insert into public.acordos_titulos(aluno_id, documento, valor_original,
      saldo_corrigido, situacao, status, acordo_id, tipo_boleto, origem_liquidacao, origem_encerramento)
    values ($1,'4510930',$2,$2,'PAGO','quitada',$3,
            coalesce($4,'Cursos de Graduação Presencial'), $5, $6) returning id`,
    [aluno, VALOR_MENSALIDADE, acordo, ajustes.tipo_boleto ?? null,
     ajustes.origem_liquidacao ?? null, ajustes.origem_encerramento ?? null]);

  if (ajustes.origem_liquidacao_ref !== undefined) {
    await db.query(`update public.acordos_titulos set origem_liquidacao_ref = $2 where id = $1`,
      [setembro, ajustes.origem_liquidacao_ref]);
  }

  // os vínculos nascem desativando o gatilho do motor seria trapaça: criamos
  // com o gatilho ligado e o motor confirma PAGO (o acordo está QUITADO e sem
  // parcela viva), exatamente como em produção.
  await db.query(`insert into public.acordo_titulo_vinculo(acordo_id, titulo_id, vinculado_por)
    values ($1,$2,'amanda.seibel@aelbra.com.br'), ($1,$3,'amanda.seibel@aelbra.com.br')`,
    [acordo, agosto, setembro]);

  return { aluno, acordo, agosto, setembro };
}

const comoGestao = (db) => db.exec(`set request.jwt.claims = '${GESTAO}'`);

async function chamar(db, { titulo, acordo, motivo = null, confirmar = false }) {
  return await um(db, `select public.titulo_atribuicao_remover($1,$2,$3,$4)`,
    [titulo, acordo, motivo, confirmar]);
}

describe("E7 -- a bancada é o código de produção", () => {
  let db;
  beforeEach(async () => { db = await novoBanco(); });

  it("os corpos conferem com produção por md5(prosrc)", async () => {
    for (const [nome, md5] of Object.entries(MD5_PROD)) {
      const achado = await um(db,
        `select md5(p.prosrc) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
          where ns.nspname='public' and p.proname=$1`, [nome]);
      expect(achado, `corpo de ${nome} divergiu de producao`).toBe(md5);
    }
  });

  it("titulo_atribuicao_remover nao existe antes da E7", async () => {
    const semE7 = await novoBanco({ comE7: false });
    const existe = await um(semE7,
      `select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
        where ns.nspname='public' and p.proname='titulo_atribuicao_remover'`);
    expect(n(existe)).toBe(0);
  });
});

describe("SEM A E7 -- o defeito da porta antiga existe hoje", () => {
  let db;
  beforeEach(async () => { db = await novoBanco({ comE7: false }); });

  it("desvincular_titulos_acordo APAGA a linha do vinculo", async () => {
    const c = await cenarioRayssa(db);
    await comoGestao(db);
    await um(db, `select public.desvincular_titulos_acordo(array[$1]::uuid[])`, [c.setembro]);

    const linhas = await um(db,
      `select count(*) from public.acordo_titulo_vinculo where titulo_id = $1`, [c.setembro]);
    expect(n(linhas)).toBe(0); // a cadeia que o motor le foi destruida
  });

  it("desvincular_titulos_acordo reabre mensalidade COM pagamento proprio (cobranca em dobro)", async () => {
    const c = await cenarioRayssa(db);
    // agosto tem pagamento identificado no proprio numero do titulo
    await db.query(`insert into public.pagamentos(aluno_id, data_pagamento, valor_pago, titulo_numero)
      values ($1, date '2026-09-29', $2, '4510929')`, [c.aluno, VALOR_MENSALIDADE]);
    await comoGestao(db);

    const r = await um(db, `select public.desvincular_titulos_acordo(array[$1]::uuid[])`, [c.agosto]);
    expect(r.ok).toBe(true); // nao recusa: nao confere pagamento nenhum

    const sit = await um(db, `select situacao from public.acordos_titulos where id = $1`, [c.agosto]);
    expect(sit).toBe("ABERTO"); // voltou a ser cobrado o que ja foi pago
  });

  it("titulo_reabrir_quitacao_por_acordo RECUSA este caso: sem proveniencia (G2)", async () => {
    const c = await cenarioRayssa(db);
    await comoGestao(db);
    await expect(um(db, `select public.titulo_reabrir_quitacao_por_acordo($1)`, [c.setembro]))
      .rejects.toThrow(/ORIGEM_NAO_REABRIVEL/);
  });

  it("e mesmo COM proveniencia ela recusa: o acordo segue QUITADO (G6)", async () => {
    const c = await cenarioRayssa(db, { origem_liquidacao: "ACORDO_QUITADO" });
    await db.query(`update public.acordos_titulos set origem_liquidacao_ref = $2 where id = $1`,
      [c.setembro, c.acordo]);
    await comoGestao(db);
    await expect(um(db, `select public.titulo_reabrir_quitacao_por_acordo($1)`, [c.setembro]))
      .rejects.toThrow(/ACORDO_AINDA_QUITADO/);
  });

  it("desvincular_titulos_acordo nao tem portao de gestao: operador comum passa", async () => {
    const c = await cenarioRayssa(db);
    await db.exec(`set request.jwt.claims = '${OPERADOR}'`);
    const r = await um(db, `select public.desvincular_titulos_acordo(array[$1]::uuid[])`, [c.setembro]);
    expect(r.ok).toBe(true);
  });
});

describe("E7 -- simulacao e o padrao", () => {
  let db, c;
  beforeEach(async () => { db = await novoBanco(); c = await cenarioRayssa(db); await comoGestao(db); });

  it("sem p_confirmar devolve SIMULACAO com a conta de cobertura ao centavo", async () => {
    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo });
    expect(r.ok).toBe(true);
    expect(r.modo).toBe("SIMULACAO");
    expect(r.gravou).toBe(false);
    expect(r.aprovado).toBe(true);
    expect(Number(r.cobertura.recebido_no_acordo)).toBeCloseTo(3313.09, 2);
    expect(Number(r.cobertura.quitadas_antes)).toBeCloseTo(5739.46, 2);
    expect(Number(r.cobertura.descoberto_antes)).toBeCloseTo(2426.37, 2);
    expect(Number(r.cobertura.quitadas_depois)).toBeCloseTo(2869.73, 2);
    // NEGATIVO de proposito: o acordo recebeu honorario e juros alem da
    // mensalidade, entao sobra cobertura depois de retirar setembro. E a mesma
    // forma das outras tres alunas vinculadas em 26/10, todas com descoberto
    // negativo -- e o que separa a Rayssa delas.
    expect(Number(r.cobertura.descoberto_depois)).toBeCloseTo(-443.36, 2);
    expect(r.estado_proposto.situacao).toBe("ABERTO");
    expect(r.estado_anterior.documento).toBe("4510930");
    expect(r.caso_reabre_pelo_cron).toBe(true);
  });

  it("simulacao NAO escreve: titulo, vinculo, log e auditoria intactos", async () => {
    await chamar(db, { titulo: c.setembro, acordo: c.acordo });

    const t = (await db.query(`select situacao, status, acordo_id from public.acordos_titulos where id=$1`,
      [c.setembro])).rows[0];
    expect(t.situacao).toBe("PAGO");
    expect(t.status).toBe("quitada");
    expect(t.acordo_id).toBe(c.acordo);

    expect(n(await um(db, `select count(*) from public.acordo_titulo_vinculo
      where titulo_id=$1 and ativo`, [c.setembro]))).toBe(1);
    expect(n(await um(db, `select count(*) from public.mensalidade_reconciliacao_log`))).toBe(0);
    expect(n(await um(db, `select count(*) from public.auditoria
      where acao='TITULO_ATRIBUICAO_REMOVIDA'`))).toBe(0);
    expect(n(await um(db, `select count(*) from public._chamadas_recalcular`))).toBe(0);
  });

  it("confirmar sem motivo recusa e nao escreve", async () => {
    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo, confirmar: true });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("MOTIVO_OBRIGATORIO");
    expect(r.gravou).toBe(false);
    expect(await um(db, `select situacao from public.acordos_titulos where id=$1`, [c.setembro])).toBe("PAGO");
  });
});

describe("E7 -- o desfecho confirmado", () => {
  let db, c, r;
  beforeEach(async () => {
    db = await novoBanco();
    c = await cenarioRayssa(db);
    await comoGestao(db);
    r = await chamar(db, { titulo: c.setembro, acordo: c.acordo,
      motivo: "setembro veio no bordero 723 e nao foi negociada no acordo 74229", confirmar: true });
  });

  it("o titulo volta a ABERTO, sem acordo e sem proveniencia", async () => {
    expect(r.ok).toBe(true);
    expect(r.modo).toBe("CONFIRMADO");
    expect(r.gravou).toBe(true);
    const t = (await db.query(`select situacao, status, acordo_id, origem_liquidacao,
      origem_liquidacao_ref, origem_liquidacao_em from public.acordos_titulos where id=$1`,
      [c.setembro])).rows[0];
    expect(t.situacao).toBe("ABERTO");
    expect(t.status).toBe("em_aberto");
    expect(t.acordo_id).toBe(null);
    expect(t.origem_liquidacao).toBe(null);
    expect(t.origem_liquidacao_ref).toBe(null);
    expect(t.origem_liquidacao_em).toBe(null);
    expect(Number(r.valor_devolvido_a_cobranca)).toBeCloseTo(2869.73, 2);
  });

  it("o vinculo e DESATIVADO e a linha CONTINUA na tabela", async () => {
    const v = (await db.query(`select ativo, motivo_desvinculo from public.acordo_titulo_vinculo
      where titulo_id=$1 and acordo_id=$2`, [c.setembro, c.acordo])).rows;
    expect(v.length).toBe(1);        // nunca apagada
    expect(v[0].ativo).toBe(false);
    expect(v[0].motivo_desvinculo).toContain("setembro veio no bordero 723");
  });

  it("agosto, o acordo, a parcela e o pagamento ficam intactos", async () => {
    const ag = (await db.query(`select situacao, status, acordo_id from public.acordos_titulos where id=$1`,
      [c.agosto])).rows[0];
    expect(ag.situacao).toBe("PAGO");
    expect(ag.status).toBe("quitada");
    expect(ag.acordo_id).toBe(c.acordo);

    expect(await um(db, `select status from public.acordos where id=$1`, [c.acordo])).toBe("QUITADO");
    expect(await um(db, `select status from public.parcelas where acordo_id=$1`, [c.acordo])).toBe("PAGO");
    expect(n(await um(db, `select count(*) from public.pagamentos where aluno_id=$1`, [c.aluno]))).toBe(1);
    expect(Number(await um(db, `select valor_pago from public.pagamentos where aluno_id=$1`,
      [c.aluno]))).toBeCloseTo(3313.09, 2);
  });

  it("depois da remocao o acordo passa a cobrir o que restou", async () => {
    const r2 = await chamar(db, { titulo: c.agosto, acordo: c.acordo });
    expect(r2.ok).toBe(false);
    expect(r2.motivo).toBe("ACORDO_COBRE_AS_MENSALIDADES");
  });

  it("grava o livro de registro com antes e depois", async () => {
    const l = (await db.query(`select * from public.mensalidade_reconciliacao_log`)).rows;
    expect(l.length).toBe(1);
    expect(l[0].lote).toBe("REMOVER_ATRIBUICAO_SEM_LASTRO");
    expect(l[0].documento).toBe("4510930");
    expect(l[0].situacao_antes).toBe("PAGO");
    expect(l[0].status_antes).toBe("quitada");
    expect(l[0].situacao_depois).toBe("ABERTO");
    expect(l[0].status_depois).toBe("em_aberto");
    expect(n(l[0].numero_acordo)).toBe(5696);
    expect(l[0].executado_por).toBe("amanda.seibel@aelbra.com.br");
    expect(l[0].motivo).toContain("setembro veio no bordero 723");
  });

  it("grava auditoria com estado anterior, posterior, cobertura e responsavel", async () => {
    const a = (await db.query(`select * from public.auditoria
      where acao='TITULO_ATRIBUICAO_REMOVIDA'`)).rows;
    expect(a.length).toBe(1);
    expect(a[0].usuario).toBe("amanda.seibel@aelbra.com.br");
    expect(a[0].detalhes.estado_anterior.situacao).toBe("PAGO");
    expect(a[0].detalhes.estado_anterior.vinculo_id).toBe(r.vinculo_id);
    expect(a[0].detalhes.estado_posterior.situacao).toBe("ABERTO");
    expect(a[0].detalhes.estado_posterior.vinculo_ativo).toBe(false);
    expect(Number(a[0].detalhes.cobertura.descoberto_antes)).toBeCloseTo(2426.37, 2);
    expect(a[0].detalhes.motivo).toContain("bordero 723");
  });

  it("delega o recalculo de saldo e situacao a funcao canonica", async () => {
    const ch = (await db.query(`select * from public._chamadas_recalcular`)).rows;
    expect(ch.some((x) => x.aluno_id === c.aluno && x.lote === "e7_atribuicao_remover")).toBe(true);
  });
});

describe("E7 -- idempotencia", () => {
  it("a segunda confirmacao devolve JA_REMOVIDO e nao grava de novo", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db);
    await comoGestao(db);
    const args = { titulo: c.setembro, acordo: c.acordo, motivo: "primeira vez", confirmar: true };

    const r1 = await chamar(db, args);
    expect(r1.gravou).toBe(true);

    const r2 = await chamar(db, { ...args, motivo: "segunda vez" });
    expect(r2.ok).toBe(true);
    expect(r2.motivo).toBe("JA_REMOVIDO");
    expect(r2.gravou).toBe(false);

    expect(n(await um(db, `select count(*) from public.mensalidade_reconciliacao_log`))).toBe(1);
    expect(n(await um(db, `select count(*) from public.auditoria
      where acao='TITULO_ATRIBUICAO_REMOVIDA'`))).toBe(1);
  });
});

describe("E7 -- seguranca: o portao", () => {
  let db, c;
  beforeEach(async () => { db = await novoBanco(); c = await cenarioRayssa(db); });

  it("operador comum recebe 42501, mesmo em simulacao", async () => {
    await db.exec(`set request.jwt.claims = '${OPERADOR}'`);
    await expect(chamar(db, { titulo: c.setembro, acordo: c.acordo })).rejects.toThrow(/gestao/i);
  });

  it("identidade nula recebe 42501 -- NULL nao passa por omissao", async () => {
    await db.exec(`set request.jwt.claims = ''`);
    await expect(chamar(db, { titulo: c.setembro, acordo: c.acordo })).rejects.toThrow(/gestao/i);
  });

  it("DIRETORIA passa: usuarios.perfil='diretoria' e ativo", async () => {
    await db.query(`insert into public.usuarios(email, perfil, ativo)
      values ('diretoria@aelbra.com.br','diretoria',true)`);
    await db.exec(`set request.jwt.claims = '{"email":"diretoria@aelbra.com.br"}'`);
    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo });
    expect(r.ok).toBe(true);
    expect(r.modo).toBe("SIMULACAO");
  });

  it("diretoria INATIVA nao passa", async () => {
    await db.query(`insert into public.usuarios(email, perfil, ativo)
      values ('exdiretoria@aelbra.com.br','diretoria',false)`);
    await db.exec(`set request.jwt.claims = '{"email":"exdiretoria@aelbra.com.br"}'`);
    await expect(chamar(db, { titulo: c.setembro, acordo: c.acordo }))
      .rejects.toThrow(/gestao|diretoria/i);
  });

  it("outro perfil em usuarios nao passa (operador cadastrado nao e diretoria)", async () => {
    await db.query(`insert into public.usuarios(email, perfil, ativo)
      values ('cobranca06@aelbra.com.br','operador',true)`);
    await db.exec(`set request.jwt.claims = '${OPERADOR}'`);
    await expect(chamar(db, { titulo: c.setembro, acordo: c.acordo }))
      .rejects.toThrow(/gestao|diretoria/i);
  });

  it("service_role passa (backend/cron)", async () => {
    await db.exec(`set request.jwt.claims = '${SERVICE}'`);
    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo });
    expect(r.ok).toBe(true);
    expect(r.modo).toBe("SIMULACAO");
  });

  it("recusa de portao nao escreve nada", async () => {
    await db.exec(`set request.jwt.claims = '${OPERADOR}'`);
    await expect(chamar(db, { titulo: c.setembro, acordo: c.acordo, motivo: "x", confirmar: true }))
      .rejects.toThrow();
    expect(await um(db, `select situacao from public.acordos_titulos where id=$1`, [c.setembro])).toBe("PAGO");
    expect(n(await um(db, `select count(*) from public.mensalidade_reconciliacao_log`))).toBe(0);
  });
});

describe("E7 -- protecao contra cobranca em dobro", () => {
  it("recusa titulo com PRIME_LIQUIDACAO_OFICIAL", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db, { origem_liquidacao: "PRIME_LIQUIDACAO_OFICIAL" });
    await comoGestao(db);
    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("LIQUIDACAO_OFICIAL_COMPROVADA");
  });

  it("o gatilho de producao tambem coage, se alguem contornar a E7", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db, { origem_liquidacao: "PRIME_LIQUIDACAO_OFICIAL" });
    await comoGestao(db);
    // escrita crua, por fora da E7
    await db.query(`update public.acordos_titulos set situacao='ABERTO', status='em_aberto' where id=$1`,
      [c.setembro]);
    const t = (await db.query(`select situacao, status from public.acordos_titulos where id=$1`,
      [c.setembro])).rows[0];
    expect(t.situacao).toBe("PAGO");   // coagido de volta
    expect(t.status).toBe("quitada");
    expect(n(await um(db, `select count(*) from public.auditoria
      where acao='TITULO_LIQUIDADO_REABERTURA_RECUSADA'`))).toBe(1);
  });

  it("recusa titulo que tem pagamento no PROPRIO numero", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db);
    await db.query(`insert into public.pagamentos(aluno_id, data_pagamento, valor_pago, titulo_numero)
      values ($1, date '2026-09-20', $2, '4510930')`, [c.aluno, VALOR_MENSALIDADE]);
    await comoGestao(db);
    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("TITULO_TEM_PAGAMENTO_PROPRIO");
  });

  it("recusa quando o acordo cobre todas as mensalidades que quitou", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db);
    await comoGestao(db);
    // o caso das outras tres alunas de 26/10: um titulo so, descoberto negativo
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where titulo_id=$1`, [c.setembro]);
    await db.query(`update public.acordos_titulos set situacao='ABERTO', status='em_aberto',
      acordo_id=null where id=$1`, [c.setembro]);
    const r = await chamar(db, { titulo: c.agosto, acordo: c.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("ACORDO_COBRE_AS_MENSALIDADES");
    expect(Number(r.cobertura.descoberto_antes)).toBeLessThan(0);
  });

  it("recusa quando retirar o titulo nao fecha a conta", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db);
    await comoGestao(db);
    // um terceiro titulo varrido: retirar so um deixa descoberto
    const outubro = await um(db, `insert into public.acordos_titulos(aluno_id, documento,
        valor_original, saldo_corrigido, situacao, status, acordo_id)
      values ($1,'4510931',$2,$2,'PAGO','quitada',$3) returning id`,
      [c.aluno, VALOR_MENSALIDADE, c.acordo]);
    await db.query(`insert into public.acordo_titulo_vinculo(acordo_id, titulo_id) values ($1,$2)`,
      [c.acordo, outubro]);

    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("REMOCAO_NAO_FECHA_A_CONTA");
    expect(Number(r.cobertura.descoberto_depois)).toBeGreaterThan(0);
  });
});

describe("E7 -- as outras guardas", () => {
  let db, c;
  beforeEach(async () => { db = await novoBanco(); c = await cenarioRayssa(db); await comoGestao(db); });

  it("recusa encerramento administrativo", async () => {
    const db2 = await novoBanco();
    const c2 = await cenarioRayssa(db2, { origem_encerramento: "CONFERENCIA_PRIME_ADMINISTRATIVA" });
    await comoGestao(db2);
    const r = await chamar(db2, { titulo: c2.setembro, acordo: c2.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("ENCERRADO_ADMINISTRATIVAMENTE");
  });

  it("recusa titulo do proprio acordo (tipo_boleto = Acordo)", async () => {
    const db2 = await novoBanco();
    const c2 = await cenarioRayssa(db2, { tipo_boleto: "Acordo" });
    await comoGestao(db2);
    const r = await chamar(db2, { titulo: c2.setembro, acordo: c2.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("TITULO_DE_ACORDO");
  });

  it("FRONTEIRA COM A E6: proveniencia de outro acordo manda mover, nao retirar", async () => {
    const db2 = await novoBanco();
    const outro = "11111111-1111-1111-1111-111111111111";
    const c2 = await cenarioRayssa(db2, { origem_liquidacao: "ACORDO_QUITADO", origem_liquidacao_ref: outro });
    await comoGestao(db2);
    const r = await chamar(db2, { titulo: c2.setembro, acordo: c2.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("PROVENIENCIA_DE_OUTRO_ACORDO");
  });

  it("recusa titulo que nao esta quitado", async () => {
    await db.query(`update public.acordo_titulo_vinculo set ativo=false where titulo_id=$1`, [c.setembro]);
    await db.query(`update public.acordos_titulos set situacao='NEGOCIADO', status='vinculada' where id=$1`,
      [c.setembro]);
    const r = await chamar(db, { titulo: c.setembro, acordo: c.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("NAO_ESTA_QUITADO");
  });

  it("recusa quando nao ha vinculo ativo com ESTE acordo", async () => {
    const outroAcordo = await um(db, `insert into public.acordos(aluno_id, status, valor_total,
      numero_acordo) values ($1,'QUITADO',100,9999) returning id`, [c.aluno]);
    const r = await chamar(db, { titulo: c.setembro, acordo: outroAcordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("SEM_VINCULO_ATIVO_NESTE_ACORDO");
  });

  it("recusa parametros incompletos", async () => {
    const r = await chamar(db, { titulo: c.setembro, acordo: null });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("PARAMETROS_INCOMPLETOS");
  });

  it("titulo inexistente e erro dito, nao silencio", async () => {
    const r = await chamar(db, { titulo: "22222222-2222-2222-2222-222222222222", acordo: c.acordo });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe("TITULO_NAO_ENCONTRADO");
  });
});

describe("E7 -- concorrencia", () => {
  // PGlite roda numa instancia so: nao da para abrir duas sessoes de verdade.
  // O que se testa aqui e o MECANISMO -- a clausula de concorrencia otimista
  // `and situacao = <lido> and status = <lido>`. Um gatilho de teste muda o
  // titulo POR BAIXO da funcao, no exato instante em que ela desativa o
  // vinculo: e o que uma transacao concorrente faria.
  it("aborta se o titulo muda de estado durante a transicao, e nao escreve", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db);
    await db.exec(`
      create or replace function public._teste_muda_por_baixo() returns trigger
      language plpgsql as $body$
      begin
        if new.ativo = false then
          update public.acordos_titulos set situacao='NEGOCIADO', status='vinculada'
           where id = new.titulo_id;
        end if;
        return new;
      end; $body$;
      create trigger zzz_teste_muda_por_baixo after update on public.acordo_titulo_vinculo
        for each row execute function public._teste_muda_por_baixo();
    `);
    await comoGestao(db);

    await expect(chamar(db, { titulo: c.setembro, acordo: c.acordo,
      motivo: "corrida", confirmar: true })).rejects.toThrow(/ATRIBUICAO_REMOVER_ABORTADA/);

    // a transacao morreu inteira: nada gravado
    expect(await um(db, `select situacao from public.acordos_titulos where id=$1`, [c.setembro])).toBe("PAGO");
    expect(n(await um(db, `select count(*) from public.mensalidade_reconciliacao_log`))).toBe(0);
    expect(n(await um(db, `select count(*) from public.acordo_titulo_vinculo
      where titulo_id=$1 and ativo`, [c.setembro]))).toBe(1);
  });

  it("o passe de confirmacao existe: o motor reavalia e concorda com ABERTO", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db);
    await comoGestao(db);
    await chamar(db, { titulo: c.setembro, acordo: c.acordo, motivo: "ok", confirmar: true });
    // chamar o motor de novo nao reverte: sem vinculo ativo, ABERTO e a decisao dele
    await um(db, `select public.titulo_reavaliar($1)`, [c.setembro]);
    const t = (await db.query(`select situacao, status, acordo_id from public.acordos_titulos where id=$1`,
      [c.setembro])).rows[0];
    expect(t.situacao).toBe("ABERTO");
    expect(t.status).toBe("em_aberto");
    expect(t.acordo_id).toBe(null);
  });
});

describe("E7 -- rollback", () => {
  it("o rollback derruba a funcao e devolve o schema ao estado anterior", async () => {
    const db = await novoBanco();
    expect(n(await um(db, `select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='titulo_atribuicao_remover'`))).toBe(1);

    await db.exec(E7_ROLLBACK);
    expect(n(await um(db, `select count(*) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
      where ns.nspname='public' and p.proname='titulo_atribuicao_remover'`))).toBe(0);

    // e nao levou nada mais consigo
    for (const [nome, md5] of Object.entries(MD5_PROD)) {
      const achado = await um(db,
        `select md5(p.prosrc) from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
          where ns.nspname='public' and p.proname=$1`, [nome]);
      expect(achado, `${nome} mudou com o rollback`).toBe(md5);
    }
  });

  it("o rollback PRESERVA o registro de uma decisao ja tomada", async () => {
    const db = await novoBanco();
    const c = await cenarioRayssa(db);
    await comoGestao(db);
    await chamar(db, { titulo: c.setembro, acordo: c.acordo, motivo: "decidido", confirmar: true });
    await db.exec(E7_ROLLBACK);

    expect(n(await um(db, `select count(*) from public.mensalidade_reconciliacao_log
      where lote='REMOVER_ATRIBUICAO_SEM_LASTRO'`))).toBe(1);
    // e o caminho de volta continua existindo, porque o vinculo nao foi apagado
    expect(n(await um(db, `select count(*) from public.acordo_titulo_vinculo
      where titulo_id=$1`, [c.setembro]))).toBe(1);
  });
});

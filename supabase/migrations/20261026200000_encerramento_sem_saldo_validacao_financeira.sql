-- ENCERRAMENTO OPERACIONAL: O TEXTO DEIXA DE VALER COMO PROVA DE SALDO ZERO
--
-- O problema, medido em producao em 26/10/2026. `caso_encerrado_operacional` e
-- o predicado que 39 funcoes e 1 view consultam para saber se um caso esta fora
-- da operacao. Ele decide em quatro linhas:
--
--   linha 1: bloqueio institucional (JURIDICO/CANCELAMENTO/SUSPENSAO) -> true
--   linha 2: texto 'SEM SALDO EM ABERTO'      -> true   SEM olhar dinheiro
--   linha 3: texto 'SALDO ZERO CONFIRMADO'    -> true   SEM olhar dinheiro
--   linha 4: texto de quitacao E saldo_titulos_aberto(p_cpf) = 0 -> true
--
-- As linhas 2 e 3 sao um desvio por cima de uma conferencia que a propria
-- funcao ja tem na linha 4 -- onde 'SEM SALDO EM ABERTO' JA ESTA na lista de
-- textos (so 'SALDO ZERO CONFIRMADO' precisa entrar). As tres funcoes da area
-- discordavam sobre as mesmas 27 linhas: a canonica
-- `aluno_saldo_pendente_detalhe` dizia pendencia em 27/27;
-- `caso_saldo_zerado_real` -- o que o ESCRITOR confere -- dizia zerado em 0/27;
-- e o predicado dizia encerrado em 27/27. O lado que escreve esta correto: o
-- defeito e inteiro do lado que le.
--
-- A REVISAO DE SEGURANCA MOSTROU QUE O PREDICADO NAO E O UNICO LUGAR, e esta
-- migration trata os quatro bloqueios que ela mediu:
--
--   (a) NIVEL ALUNO. Sete consumidores chamam o predicado com `alunos.*` e
--       `status_financeiro = null`, nao com `casos.*`: `acoes_massivas_universo`,
--       `buscar_candidatos_acoes_massivas`, `total_elegiveis_acoes_massivas`,
--       `receber_leads`, `resumo_carteira_operador`,
--       `casos_encerrar_zerados_sem_debito` e `_penetracao_ano_montar`. Sao 242
--       alunos / R$ 314.774,13 que mudam de resposta, 224 deles barrados hoje
--       exatamente nesse degrau -- e ~209 virariam disponiveis a partir de
--       27/10, quando o giro de fidelizacao de 221 deles vence. Por isso o
--       congelamento tem escopo ALUNO, alem de CASO.
--   (b) CRON 8 (`fidelizacao_liberar_vencidos`, 08:20, ativo) soltaria 8 casos
--       / R$ 7.584,60 da carteira do operador na primeira execucao. Ele chama
--       `caso_protegido_redistribuicao` (que barra `nao_acionar`) e o predicado,
--       mas nao conhecia o congelamento.
--   (c) `aluno_saldo_pendente_detalhe(null)` devolve `'0.00'`, nao NULL: um caso
--       sem `aluno_id` passaria por "saldo zero" sem conferir dinheiro nenhum --
--       o espelho exato do furo de CPF vazio. Agora aluno indeterminado e
--       SITUACAO NAO COMPROVADA, nunca saldo zero.
--   (d) CICLO DE REABERTURA. `casos_reabrir_com_divida` seleciona pelo primeiro
--       lado do OR (`encerrado_operacional`), reabria o caso congelado e o
--       recalculo fechava de novo na mesma passagem, deixando um
--       `REABERTURA_DIVIDA_NOVA` para um caso que nao reabriu. Agora ele nao
--       tenta o congelado.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao mexe em dinheiro, nao da baixa, nao altera
-- status de caso ou aluno, nao reabre nada, nao recalcula
-- `casos.encerrado_operacional`, e nao inventa autor nem data para o que ja
-- estava classificado (o registro legado declara o autor como desconhecido).

begin;

-- ---------------------------------------------------------------------------
-- 1. A trilha, com escopo CASO e ALUNO.
-- ---------------------------------------------------------------------------
create table if not exists public.caso_encerramento_sem_saldo (
  id                bigserial primary key,
  escopo            text not null,
  caso_id           uuid references public.casos(id) on delete cascade,
  aluno_id          uuid,
  cpf_congelado     text,
  classificacao     text not null,
  saldo_no_momento  numeric,
  estado_anterior   jsonb not null,
  justificativa     text not null,
  decidido_por      text,
  decidido_em       timestamptz,
  origem            text not null,
  evidencia         jsonb,
  resolvido_em      timestamptz,
  resolvido_por     text,
  registrado_em     timestamptz not null default now(),
  constraint caso_encerramento_sem_saldo_escopo_check check (escopo in ('CASO','ALUNO')),
  constraint caso_encerramento_sem_saldo_alvo_check check (
    (escopo = 'CASO'  and caso_id  is not null) or
    (escopo = 'ALUNO' and aluno_id is not null)),
  constraint caso_encerramento_sem_saldo_classificacao_check check (classificacao in
    ('SEM_SALDO_CONFERIDO','BLOQUEIO_INSTITUCIONAL','NAO_ACIONAR','OUTRO_CASO_ATIVO',
     'LEGADO_NAO_CONFERIDO','ALUNO_LEGADO_NAO_CONFERIDO','SALDO_NAO_COMPROVADO',
     'MANTIDO_PELA_GESTAO','DEVOLVIDO_A_COBRANCA')),
  constraint caso_encerramento_sem_saldo_origem_check check (origem in ('ROTINA','GESTAO','MIGRATION'))
);

comment on table public.caso_encerramento_sem_saldo is
  'Trilha APPEND-ONLY do encerramento operacional por ausencia de saldo: data, responsavel, justificativa e estado anterior. Um registro VIGENTE (resolvido_em nulo) congela o alvo. Escopo CASO para os consumidores que passam casos.*; escopo ALUNO para os sete que passam alunos.*.';

-- Um vigente por caso e um por aluno. Sao tambem as travas de concorrencia:
-- duas rotinas que tentem congelar o mesmo alvo nao conseguem as duas.
create unique index if not exists caso_encerramento_sem_saldo_vigente_caso
  on public.caso_encerramento_sem_saldo (caso_id)
  where resolvido_em is null and caso_id is not null;

create unique index if not exists caso_encerramento_sem_saldo_vigente_aluno
  on public.caso_encerramento_sem_saldo (aluno_id)
  where resolvido_em is null and escopo = 'ALUNO';

-- A busca que o predicado faz em todas as chamadas: so recebe CPF.
create index if not exists caso_encerramento_sem_saldo_cpf_vigente
  on public.caso_encerramento_sem_saldo (cpf_congelado)
  where resolvido_em is null and cpf_congelado is not null;

create index if not exists caso_encerramento_sem_saldo_pendente_idx
  on public.caso_encerramento_sem_saldo (classificacao, registrado_em desc)
  where resolvido_em is null;

-- Trilha e trilha: nao se corrige, nao se apaga. Resolver e marcar
-- `resolvido_em`/`resolvido_por` e gravar linha nova -- por isso o UPDATE e
-- aceito, mas so nessas duas colunas e so de nulo para valor.
create or replace function public._caso_encerramento_sem_saldo_imutavel()
returns trigger
language plpgsql
as $function$
begin
  if tg_op = 'DELETE' then
    -- `caso_id ... on delete cascade`: quando o CASO e apagado, o Postgres
    -- apaga a linha filha e cai aqui. Recusar isso trancaria o caso para
    -- sempre. No cascata o pai JA nao existe mais; no delete direto, existe.
    if old.caso_id is not null and not exists (select 1 from public.casos c where c.id = old.caso_id) then
      return old;
    end if;
    raise exception 'TRILHA_IMUTAVEL: a trilha do encerramento por ausencia de saldo nao aceita delete.'
      using errcode = '42501';
  end if;
  if old.resolvido_em is not null then
    raise exception 'TRILHA_IMUTAVEL: o registro % ja foi resolvido em % e nao muda mais.', old.id, old.resolvido_em
      using errcode = '42501';
  end if;
  if new.escopo is distinct from old.escopo
     or new.caso_id is distinct from old.caso_id
     or new.aluno_id is distinct from old.aluno_id
     or new.cpf_congelado is distinct from old.cpf_congelado
     or new.classificacao is distinct from old.classificacao
     or new.saldo_no_momento is distinct from old.saldo_no_momento
     or new.estado_anterior is distinct from old.estado_anterior
     or new.justificativa is distinct from old.justificativa
     or new.decidido_por is distinct from old.decidido_por
     or new.decidido_em is distinct from old.decidido_em
     or new.origem is distinct from old.origem
     or new.evidencia is distinct from old.evidencia
     or new.registrado_em is distinct from old.registrado_em then
    raise exception 'TRILHA_IMUTAVEL: so `resolvido_em` e `resolvido_por` podem ser preenchidos; o resto do registro nao muda.'
      using errcode = '42501';
  end if;
  if new.resolvido_em is null then
    raise exception 'TRILHA_IMUTAVEL: resolver exige `resolvido_em`.' using errcode = '42501';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_caso_encerramento_sem_saldo_imutavel on public.caso_encerramento_sem_saldo;
create trigger trg_caso_encerramento_sem_saldo_imutavel
  before update or delete on public.caso_encerramento_sem_saldo
  for each row execute function public._caso_encerramento_sem_saldo_imutavel();

-- Tabela nova no schema public herda arwdDxtm para `authenticated` -- inclusive
-- TRUNCATE, que RLS nao cobre. Aqui a gestao LE e mais nada.
revoke all on public.caso_encerramento_sem_saldo from authenticated, anon;
revoke all on sequence public.caso_encerramento_sem_saldo_id_seq from authenticated, anon;
grant select on public.caso_encerramento_sem_saldo to authenticated;

alter table public.caso_encerramento_sem_saldo enable row level security;
drop policy if exists caso_encerramento_sem_saldo_leitura_gestao on public.caso_encerramento_sem_saldo;
create policy caso_encerramento_sem_saldo_leitura_gestao
  on public.caso_encerramento_sem_saldo
  for select to authenticated
  using (coalesce(public.usuario_e_gestao(), false));

-- ---------------------------------------------------------------------------
-- 2. Consultas do congelamento.
-- ---------------------------------------------------------------------------
create or replace function public._cpf11(p_cpf text)
returns text
language sql
immutable
as $function$
  select nullif(lpad(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g'), 11, '0'), '00000000000');
$function$;

-- A consulta que o predicado faz. Tres portas, e cada uma com o seu limite --
-- medido, nao suposto:
--
--   caso_id  identidade exata, vale sempre;
--   aluno_id so em chamada de NIVEL ALUNO (`p_caso_id is null`). Um caso ATIVO
--            do mesmo aluno nao pode herdar o congelamento dele;
--   CPF      a unica porta que a assinatura de 5 argumentos consegue usar, e
--            por isso a mais perigosa: ela exige que os QUATRO status da
--            avaliacao sejam os MESMOS do retrato congelado. Sem essa exigencia,
--            o congelamento de ALUNO atingiria os casos ATIVOS que compartilham
--            o CPF -- 243 casos / R$ 319.168,86, 242 com operador, medidos em
--            producao em 26/10. Dos 243, ZERO tem os mesmos status do retrato,
--            entao a coincidencia de status separa os dois grupos sem perder
--            protecao.
create or replace function public._encerramento_congelado(
  p_aluno_id uuid, p_caso_id uuid, p_cpf text,
  p_nat text default null, p_nac text default null, p_nfi text default null, p_njo text default null)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.caso_encerramento_sem_saldo e
     where e.resolvido_em is null
       and (
         e.caso_id = p_caso_id
         or (p_caso_id is null and e.escopo = 'ALUNO' and e.aluno_id = p_aluno_id)
         or (e.cpf_congelado is not null
             and e.cpf_congelado = public._cpf11(p_cpf)
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_atual','')) = coalesce(p_nat,'')
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_acionamento','')) = coalesce(p_nac,'')
             and public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_jornada','')) = coalesce(p_njo,'')
             and (e.escopo = 'ALUNO'
                  or public.normalizar_status_acionamento(coalesce(e.estado_anterior->>'status_financeiro','')) = coalesce(p_nfi,'')))));
$function$;

create or replace function public.caso_encerramento_congelado(p_caso_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.caso_encerramento_sem_saldo e
                  where e.resolvido_em is null and e.caso_id = p_caso_id);
$function$;

grant execute on function public._cpf11(text) to authenticated, service_role;
grant execute on function public._encerramento_congelado(uuid,uuid,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.caso_encerramento_congelado(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. A conferencia financeira. Aluno indeterminado = NAO COMPROVADO.
--
-- `aluno_saldo_pendente_detalhe(null)` devolve `'0.00'`, nao NULL: confiar nela
-- com aluno nulo seria repetir, por outro caminho, o furo que esta migration
-- fecha. Entao: com aluno, usa a canonica; sem aluno, tenta resolver pelo CPF e,
-- se nao achar exatamente um, devolve FALSE -- nao "sem saldo".
-- ---------------------------------------------------------------------------
create or replace function public._caso_sem_saldo_conferido(p_aluno_id uuid, p_cpf text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_cpf  text := public._cpf11(p_cpf);
  v_aid  uuid := p_aluno_id;
  v_n    int;
begin
  if v_aid is null then
    if v_cpf is null then
      return false;  -- sem aluno e sem CPF: nada comprovado
    end if;
    -- `min(uuid)` NAO existe em Postgres: contar e buscar sao dois passos.
    select count(*) into v_n
      from public.alunos al
     where lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf;
    if coalesce(v_n,0) <> 1 then
      return false;  -- nenhum aluno, ou mais de um: situacao nao comprovada
    end if;
    select al.id into v_aid
      from public.alunos al
     where lpad(regexp_replace(coalesce(al.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf
     limit 1;
  end if;
  return coalesce((public.aluno_saldo_pendente_detalhe(v_aid)->>'total')::numeric, -1) <= 0.005;
end;
$function$;

grant execute on function public._caso_sem_saldo_conferido(uuid,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. A regra nova, num lugar so. As duas assinaturas publicas delegam aqui.
-- ---------------------------------------------------------------------------
create or replace function public._caso_encerrado_operacional_regra(
  p_aluno_id uuid, p_caso_id uuid, p_cpf text,
  p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- 'SALDO ZERO CONFIRMADO' entrou aqui: ele tinha linha propria sem
  -- conferencia e NAO estava neste array -- tira-lo da linha propria sem
  -- acrescentar aqui o faria perder efeito em vez de passar a ser conferido.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                       'SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO',
                       'ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO',
                       'SALDO ZERO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  -- linha 1, INTACTA: suspensao, cancelamento e juridico saem da operacao
  -- independentemente de dinheiro.
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;

  -- congelamento: a decisao que existia antes da troca fica de pe ate a gestao
  -- resolver. Vale por caso, por aluno ou por CPF.
  if public._encerramento_congelado(p_aluno_id, p_caso_id, p_cpf, nat, nac, nfi, njo) then return true; end if;

  -- o texto agora precisa de conferencia financeira.
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit))
     and public._caso_sem_saldo_conferido(p_aluno_id, p_cpf) then return true; end if;

  return false;
end;
$function$;

grant execute on function public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. CONGELAMENTO, calculado com o predicado ANTIGO ainda no lugar.
--
-- Grava um registro para todo alvo cuja resposta mudaria -- nos DOIS escopos.
--
-- ALCANCE EXATO, medido, sem arredondar para o lado bonito: a resposta do
-- predicado continua igual para todos os alvos que a assinatura de 5 argumentos
-- consegue achar -- isto e, os que tem CPF utilizavel ou chegam pela sobrecarga
-- de 7 argumentos. Ela MUDA para os 56 casos que nao tem `aluno_id` NEM CPF
-- utilizavel: o registro deles existe (a chave e `caso_id`), mas a assinatura
-- de 5 argumentos nao recebe `caso_id` e portanto nao os alcanca. Esses 56
-- passam a responder "nao encerrado", o que e a regra funcionando -- aluno
-- indeterminado e situacao nao comprovada --, e NAO ficam disponiveis:
-- `fila_casos_sem_responsavel` faz INNER JOIN com `alunos`, `assumir_caso_livre`
-- exige saldo > 0 (e com CPF vazio o saldo sai 0), `acoes_massivas_universo`
-- monta o universo de `alunos`, e o cron 8 e o reabridor os seguram pela guarda
-- por `caso_id`. Nenhum caso ou aluno fica disponivel para fila, carteira,
-- distribuicao ou acao massiva por causa desta migration.
--
-- NAO INVENTA INFORMACAO AUSENTE: quem classificou o alvo originalmente e
-- quando nao consta em registro nenhum (nos 2.895 casos do atalho, zero tem
-- linha em `auditoria`; `caso_atualizado_em` nao serve, porque
-- `recalcular_situacao_aluno` toca casos ja encerrados). `decidido_por` e
-- `decidido_em` ficam NULOS e a justificativa diz isso com palavras.
-- ---------------------------------------------------------------------------
do $congelar$
declare
  v_bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO','SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  v_bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO','SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  v_casos int; v_alunos int;
  v_nota text := 'Congelado na migration 20261026200000, antes de a regra passar a exigir conferencia financeira. '
    || 'O alvo continua encerrado como estava. Quem o classificou originalmente e quando NAO consta em nenhum '
    || 'registro do sistema, portanto o autor e a data da decisao original ficam em branco de proposito, em vez '
    || 'de serem supostos. A gestao decide caso a caso por caso_encerramento_resolver.';
begin
  -- Os dois escopos sao SELECIONADOS antes de qualquer insercao. Se o escopo
  -- CASO fosse gravado primeiro, o congelamento dele cobriria o aluno pela
  -- chave de CPF e o escopo ALUNO nunca nasceria -- e os sete consumidores que
  -- passam `alunos.*` ficariam sem registro proprio para a gestao resolver.
  create temp table _congelar_casos on commit drop as
    select c.id as caso_id from public.casos c
     where public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                             c.status_financeiro, c.status_jornada)
       and not public._caso_encerrado_operacional_regra(c.aluno_id, c.id, c.cpf_limpo, c.status_atual,
                                                        c.status_acionamento, c.status_financeiro, c.status_jornada);

  create temp table _congelar_alunos on commit drop as
    select a.id as aluno_id from public.alunos a
     where public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento,
                                             null::text, a.status_jornada)
       and not public._caso_encerrado_operacional_regra(a.id, null, a.cpf, a.status_atual,
                                                        a.status_acionamento, null::text, a.status_jornada);

  -- 5.a escopo CASO
  insert into public.caso_encerramento_sem_saldo
    (escopo, caso_id, aluno_id, cpf_congelado, classificacao, saldo_no_momento, estado_anterior,
     justificativa, decidido_por, decidido_em, origem, evidencia)
  select 'CASO', c.id, c.aluno_id,
         public._cpf11(coalesce(nullif(c.cpf_limpo,''), nullif(c.cpf,''))),
         case
           when array[public.normalizar_status_acionamento(coalesce(c.status_atual,'')),
                      public.normalizar_status_acionamento(coalesce(c.status_financeiro,'')),
                      public.normalizar_status_acionamento(coalesce(c.status_jornada,''))] && v_bloq
             or array[public.normalizar_status_acionamento(coalesce(c.status_acionamento,''))] && v_bloq_acion
             then 'BLOQUEIO_INSTITUCIONAL'
           when coalesce(c.nao_acionar, false) then 'NAO_ACIONAR'
           when exists (select 1 from public.casos c2 where c2.aluno_id = c.aluno_id and c2.id <> c.id
                         and not coalesce(c2.encerrado_operacional, false)) then 'OUTRO_CASO_ATIVO'
           when c.aluno_id is null or public._cpf11(coalesce(nullif(c.cpf_limpo,''), nullif(c.cpf,''))) is null
             then 'SALDO_NAO_COMPROVADO'
           else 'LEGADO_NAO_CONFERIDO'
         end,
         case when c.aluno_id is not null
              then round(coalesce((public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric, 0), 2) end,
         jsonb_build_object(
           'status_atual', c.status_atual, 'status_acionamento', c.status_acionamento,
           'status_financeiro', c.status_financeiro, 'status_jornada', c.status_jornada,
           'encerrado_operacional', c.encerrado_operacional, 'nao_acionar', c.nao_acionar,
           'operador_email', c.operador_email, 'caso_atualizado_em', c.caso_atualizado_em,
           'caso_atualizado_por', c.caso_atualizado_por),
         v_nota, null, null, 'MIGRATION',
         jsonb_build_object(
           'resposta_antiga', true, 'resposta_nova', false,
           'saldo_pela_funcao_por_cpf', public.saldo_titulos_aberto(c.cpf_limpo),
           'cpf_utilizavel', public._cpf11(coalesce(nullif(c.cpf_limpo,''), nullif(c.cpf,''))) is not null)
    from public.casos c
   where c.id in (select caso_id from _congelar_casos)
  on conflict do nothing;
  get diagnostics v_casos = row_count;

  -- 5.b escopo ALUNO -- os sete consumidores que passam `alunos.*` e
  -- `status_financeiro = null`. E outra populacao, nao um recorte da de cima.
  insert into public.caso_encerramento_sem_saldo
    (escopo, aluno_id, cpf_congelado, classificacao, saldo_no_momento, estado_anterior,
     justificativa, decidido_por, decidido_em, origem, evidencia)
  select 'ALUNO', a.id, public._cpf11(a.cpf),
         case
           when array[public.normalizar_status_acionamento(coalesce(a.status_atual,'')),
                      public.normalizar_status_acionamento(coalesce(a.status_jornada,''))] && v_bloq
             or array[public.normalizar_status_acionamento(coalesce(a.status_acionamento,''))] && v_bloq_acion
             then 'BLOQUEIO_INSTITUCIONAL'
           when public._cpf11(a.cpf) is null then 'SALDO_NAO_COMPROVADO'
           else 'ALUNO_LEGADO_NAO_CONFERIDO'
         end,
         round(coalesce((public.aluno_saldo_pendente_detalhe(a.id)->>'total')::numeric, 0), 2),
         jsonb_build_object(
           'status_atual', a.status_atual, 'status_acionamento', a.status_acionamento,
           'status_jornada', a.status_jornada, 'responsavel_atual_email', a.responsavel_atual_email),
         v_nota, null, null, 'MIGRATION',
         jsonb_build_object('resposta_antiga', true, 'resposta_nova', false, 'escopo_de_chamada', 'ALUNOS')
    from public.alunos a
   where a.id in (select aluno_id from _congelar_alunos)
  on conflict do nothing;
  get diagnostics v_alunos = row_count;

  raise notice 'congelamento: % caso(s) e % aluno(s) com registro vigente', v_casos, v_alunos;
end;
$congelar$;

-- ---------------------------------------------------------------------------
-- 6. As duas assinaturas publicas passam a delegar para a regra nova.
-- ---------------------------------------------------------------------------
do $patch$
declare v_md5 text;
begin
  select md5(p.prosrc) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'caso_encerrado_operacional'
     and pg_get_function_identity_arguments(p.oid) = 'p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text';
  if v_md5 is null then
    raise exception 'FUNCAO_AUSENTE: caso_encerrado_operacional(5 args)';
  end if;
  if v_md5 <> 'adc514c7a018018d866096d8e420d7b3' then
    raise exception 'MD5_INESPERADO em caso_encerrado_operacional(5 args): % (esperado adc514c7a018018d866096d8e420d7b3)', v_md5;
  end if;
end;
$patch$;

-- A assinatura antiga, que 39 funcoes e 1 view chamam. So recebe CPF: a
-- identidade do aluno e resolvida pelo CPF quando houver exatamente um, e o
-- congelamento tambem e consultado por CPF.
create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public._caso_encerrado_operacional_regra(
    null::uuid, null::uuid, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

-- A sobrecarga com identidade: e a precisa, e e a que os consumidores devem
-- passar a chamar quando tiverem `aluno_id` e `caso_id` em maos.
create or replace function public.caso_encerrado_operacional(
  p_aluno_id uuid, p_caso_id uuid, p_cpf text,
  p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public._caso_encerrado_operacional_regra(
    p_aluno_id, p_caso_id, p_cpf, p_status_atual, p_status_acionamento, p_status_financeiro, p_status_jornada);
$function$;

grant execute on function public.caso_encerrado_operacional(text,text,text,text,text) to authenticated, service_role;
grant execute on function public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. A gestao resolve. Devolver a cobranca e ato explicito dela.
-- ---------------------------------------------------------------------------
create or replace function public.caso_encerramento_resolver(
  p_caso_id       uuid,
  p_decisao       text,
  p_justificativa text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_just  text := nullif(btrim(coalesce(p_justificativa,'')), '');
  v_e     public.caso_encerramento_sem_saldo%rowtype;
  v_c     public.casos%rowtype;
  v_saldo numeric;
  v_aluno int := 0;
begin
  -- AUTORIA ANTES DE PERMISSAO: `service_role` passa pelo portao de papel sem
  -- ter e-mail no token, e a decisao ficaria gravada com autor vazio.
  if length(coalesce(v_email,'')) = 0 then
    raise exception 'AUTORIA_OBRIGATORIA: resolver exige identidade (e-mail no token).' using errcode = '42501';
  end if;
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encerramento por ausencia de saldo e decisao da gestao.' using errcode = '42501';
  end if;
  if coalesce(p_decisao,'') not in ('MANTER_ENCERRADO','DEVOLVER_A_COBRANCA') then
    raise exception 'DECISAO_INVALIDA: use MANTER_ENCERRADO ou DEVOLVER_A_COBRANCA.';
  end if;
  if length(coalesce(v_just,'')) < 15 then
    raise exception 'JUSTIFICATIVA_OBRIGATORIA: diga por que (minimo 15 caracteres).';
  end if;

  select * into v_c from public.casos where id = p_caso_id for update;
  if not found then
    raise exception 'CASO_NAO_ENCONTRADO';
  end if;

  select * into v_e from public.caso_encerramento_sem_saldo
   where caso_id = p_caso_id and escopo = 'CASO' and resolvido_em is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'SEM_REGISTRO_VIGENTE', 'caso_id', p_caso_id);
  end if;

  v_saldo := case when v_c.aluno_id is not null
                  then round(coalesce((public.aluno_saldo_pendente_detalhe(v_c.aluno_id)->>'total')::numeric, 0), 2) end;

  -- DUPLICIDADE: devolver um caso a cobranca quando o aluno ja tem outro caso
  -- aberto criaria duas frentes de cobranca para a mesma pessoa. E a trava que
  -- `casos_reabrir_com_divida` ja aplica; aqui ela vale tambem para a decisao
  -- manual, senao a porta da gestao seria mais frouxa que a da rotina. O indice
  -- `ux_casos_uma_ficha_aberta_por_aluno` barraria depois, com erro cru.
  if p_decisao = 'DEVOLVER_A_COBRANCA'
     and exists (select 1 from public.casos c2 where c2.aluno_id = v_c.aluno_id and c2.id <> p_caso_id
                  and not coalesce(c2.encerrado_operacional, false)) then
    return jsonb_build_object('ok', false, 'erro', 'ALUNO_JA_TEM_CASO_ABERTO',
      'porque', 'devolver este caso criaria uma segunda cobranca para o mesmo aluno; trate a ficha redundante primeiro',
      'caso_id', p_caso_id, 'aluno_id', v_c.aluno_id);
  end if;

  update public.caso_encerramento_sem_saldo
     set resolvido_em = now(), resolvido_por = v_email
   where id = v_e.id;

  if p_decisao = 'MANTER_ENCERRADO' then
    -- o congelamento continua, agora com autor, data e justificativa de verdade
    insert into public.caso_encerramento_sem_saldo
      (escopo, caso_id, aluno_id, cpf_congelado, classificacao, saldo_no_momento, estado_anterior,
       justificativa, decidido_por, decidido_em, origem, evidencia)
    values ('CASO', p_caso_id, v_c.aluno_id, v_e.cpf_congelado, 'MANTIDO_PELA_GESTAO', v_saldo,
            jsonb_build_object(
              'status_atual', v_c.status_atual, 'status_acionamento', v_c.status_acionamento,
              'status_financeiro', v_c.status_financeiro, 'status_jornada', v_c.status_jornada,
              'encerrado_operacional', v_c.encerrado_operacional, 'nao_acionar', v_c.nao_acionar),
            v_just, v_email, now(), 'GESTAO',
            jsonb_build_object('registro_anterior', v_e.id, 'classificacao_anterior', v_e.classificacao));
  else
    -- DEVOLVER: o congelamento de ALUNO tambem tem de sair, senao ele segue
    -- respondendo "encerrado" por CPF/aluno e a decisao nao teria efeito.
    update public.caso_encerramento_sem_saldo
       set resolvido_em = now(), resolvido_por = v_email
     where escopo = 'ALUNO' and aluno_id = v_c.aluno_id and resolvido_em is null;
    get diagnostics v_aluno = row_count;
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CASO_ENCERRAMENTO_SEM_SALDO_RESOLVIDO', 'casos', p_caso_id,
          jsonb_build_object('decisao', p_decisao, 'justificativa', v_just,
                             'classificacao_anterior', v_e.classificacao,
                             'saldo_no_momento', v_saldo, 'registro', v_e.id,
                             'congelamento_aluno_retirado', v_aluno));

  -- NAO reabre nada aqui. DEVOLVER_A_COBRANCA so retira o congelamento; quem
  -- devolve e `casos_reabrir_com_divida`, com as travas dele: `nao_acionar`,
  -- `cobranca_nao_reabrir`, bloqueio institucional e caso duplicado.
  return jsonb_build_object('ok', true, 'decisao', p_decisao, 'caso_id', p_caso_id,
                            'saldo_no_momento', v_saldo,
                            'congelamento', case when p_decisao = 'MANTER_ENCERRADO' then 'RENOVADO' else 'RETIRADO' end,
                            'congelamento_aluno_retirado', v_aluno);
end;
$function$;

grant execute on function public.caso_encerramento_resolver(uuid,text,text) to authenticated, service_role;

-- A PORTA DE SAIDA DO ESCOPO ALUNO.
--
-- `caso_encerramento_resolver` acha o registro por `caso_id and escopo = 'CASO'`.
-- Medido em producao: dos 243 alvos de aluno, so 3 tem um caso que tambem e
-- alvo de escopo CASO -- os outros 240 (R$ 316.692,09) apareciam em
-- `caso_encerramento_pendentes` e NENHUMA funcao conseguia resolve-los, nem
-- manter nem devolver. Isso contradizia a justificativa que a propria migration
-- grava em cada linha ("a gestao decide caso a caso") em 69% dos registros que
-- ela cria, e recriava o padrao que esta correcao existe para desfazer: divida
-- real, fora das filas, sem ninguem capaz de agir.
--
-- Devolver aqui NAO reabre caso nenhum: retira o congelamento do ALUNO, e com
-- isso o aluno volta a ser avaliado pela conferencia financeira nos sete
-- consumidores que passam `alunos.*`. Quem devolve caso e
-- `casos_reabrir_com_divida`, com as travas dele.
create or replace function public.caso_encerramento_resolver_aluno(
  p_aluno_id      uuid,
  p_decisao       text,
  p_justificativa text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_just  text := nullif(btrim(coalesce(p_justificativa,'')), '');
  v_e     public.caso_encerramento_sem_saldo%rowtype;
  v_a     public.alunos%rowtype;
  v_saldo numeric;
begin
  -- AUTORIA ANTES DE PERMISSAO, mesma regra do verbo de caso.
  if length(coalesce(v_email,'')) = 0 then
    raise exception 'AUTORIA_OBRIGATORIA: resolver exige identidade (e-mail no token).' using errcode = '42501';
  end if;
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encerramento por ausencia de saldo e decisao da gestao.' using errcode = '42501';
  end if;
  if coalesce(p_decisao,'') not in ('MANTER_ENCERRADO','DEVOLVER_A_COBRANCA') then
    raise exception 'DECISAO_INVALIDA: use MANTER_ENCERRADO ou DEVOLVER_A_COBRANCA.';
  end if;
  if length(coalesce(v_just,'')) < 15 then
    raise exception 'JUSTIFICATIVA_OBRIGATORIA: diga por que (minimo 15 caracteres).';
  end if;

  select * into v_a from public.alunos where id = p_aluno_id for update;
  if not found then
    raise exception 'ALUNO_NAO_ENCONTRADO';
  end if;

  select * into v_e from public.caso_encerramento_sem_saldo
   where aluno_id = p_aluno_id and escopo = 'ALUNO' and resolvido_em is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'SEM_REGISTRO_VIGENTE', 'aluno_id', p_aluno_id);
  end if;

  v_saldo := round(coalesce((public.aluno_saldo_pendente_detalhe(p_aluno_id)->>'total')::numeric, 0), 2);

  update public.caso_encerramento_sem_saldo
     set resolvido_em = now(), resolvido_por = v_email
   where id = v_e.id;

  if p_decisao = 'MANTER_ENCERRADO' then
    insert into public.caso_encerramento_sem_saldo
      (escopo, aluno_id, cpf_congelado, classificacao, saldo_no_momento, estado_anterior,
       justificativa, decidido_por, decidido_em, origem, evidencia)
    values ('ALUNO', p_aluno_id, v_e.cpf_congelado, 'MANTIDO_PELA_GESTAO', v_saldo,
            jsonb_build_object(
              'status_atual', v_a.status_atual, 'status_acionamento', v_a.status_acionamento,
              'status_jornada', v_a.status_jornada, 'responsavel_atual_email', v_a.responsavel_atual_email),
            v_just, v_email, now(), 'GESTAO',
            jsonb_build_object('registro_anterior', v_e.id, 'classificacao_anterior', v_e.classificacao));
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'ALUNO_ENCERRAMENTO_SEM_SALDO_RESOLVIDO', 'alunos', p_aluno_id,
          jsonb_build_object('decisao', p_decisao, 'justificativa', v_just,
                             'classificacao_anterior', v_e.classificacao,
                             'saldo_no_momento', v_saldo, 'registro', v_e.id));

  return jsonb_build_object('ok', true, 'decisao', p_decisao, 'aluno_id', p_aluno_id,
                            'saldo_no_momento', v_saldo,
                            'congelamento', case when p_decisao = 'MANTER_ENCERRADO' then 'RENOVADO' else 'RETIRADO' end);
end;
$function$;

grant execute on function public.caso_encerramento_resolver_aluno(uuid,text,text) to authenticated, service_role;

create or replace function public.caso_encerramento_pendentes(p_limite integer default 200)
returns table(escopo text, caso_id uuid, aluno_id uuid, aluno_nome text, classificacao text,
              saldo_no_momento numeric, estado_anterior jsonb, registrado_em timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encerramento por ausencia de saldo e decisao da gestao.' using errcode = '42501';
  end if;
  return query
  select e.escopo, e.caso_id, e.aluno_id, al.nome, e.classificacao, e.saldo_no_momento,
         e.estado_anterior, e.registrado_em
    from public.caso_encerramento_sem_saldo e
    left join public.alunos al on al.id = e.aluno_id
   where e.resolvido_em is null
   order by e.saldo_no_momento desc nulls last, e.registrado_em
   limit greatest(coalesce(p_limite, 200), 1);
end;
$function$;

grant execute on function public.caso_encerramento_pendentes(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. CRON 8: a fidelizacao nao solta quem esta congelado.
--
-- `casos_elegiveis_liberacao_fidelizacao` alimenta `liberar_casos_fidelizacao_vencida`
-- (cron 8, 08:20, ativo). Ela ja chama `caso_protegido_redistribuicao`, que barra
-- `nao_acionar`, juridico, cancelamento, confirmacao aberta e acordo ativo -- mas
-- nao conhecia o congelamento, e por isso soltaria 8 casos / R$ 7.584,60 na
-- primeira execucao depois da troca da regra. Tudo o que ela ja preservava
-- continua igual: a unica linha nova e a do congelamento.
-- ---------------------------------------------------------------------------
do $patch$
declare v_md5 text;
begin
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'casos_elegiveis_liberacao_fidelizacao';
  if v_md5 is null then raise exception 'FUNCAO_AUSENTE: casos_elegiveis_liberacao_fidelizacao'; end if;
  if v_md5 <> 'fb72379bec0573059354843c3f82ddbd' then
    raise exception 'MD5_INESPERADO em casos_elegiveis_liberacao_fidelizacao: % (esperado fb72379bec0573059354843c3f82ddbd)', v_md5;
  end if;
end;
$patch$;

create or replace function public.casos_elegiveis_liberacao_fidelizacao()
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text, data_ultimo_acionamento date, fidelizado_ate date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal'
as $function$
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
    c.data_ultimo_acionamento,
    case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
  from public.casos c
  left join public.alunos a on a.id = c.aluno_id
  where c.operador_email is not null and lower(c.operador_email) <> internal.carteira_geral_email()
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
    -- 26/10/2026: caso congelado nao e solto da carteira. Sem esta linha, a
    -- troca da regra soltaria 8 casos / R$ 7.584,60 na primeira passagem.
    and not public.caso_encerramento_congelado(c.id)
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$function$;

-- ---------------------------------------------------------------------------
-- 9. O reabridor nao tenta o congelado.
--
-- `casos_reabrir_com_divida` seleciona por `encerrado_operacional OR predicado`.
-- Pelo primeiro lado do OR ele reabria o caso congelado e `recalcular_situacao_aluno`
-- -- que le o predicado -- fechava de novo na mesma passagem: estado final certo,
-- mas sobrava um `REABERTURA_DIVIDA_NOVA` em `aluno_movimentacoes` para um caso
-- que nao reabriu. Patch ancorado de UMA linha; o resto da funcao nao muda.
-- ---------------------------------------------------------------------------
do $patch$
declare
  v_def text; v_md5 text; v_velho text; v_novo text;
begin
  select pg_get_functiondef(p.oid), md5(p.prosrc) into v_def, v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'casos_reabrir_com_divida';
  if v_def is null then raise exception 'FUNCAO_AUSENTE: casos_reabrir_com_divida'; end if;
  if position('caso_encerramento_congelado' in v_def) > 0 then
    raise notice 'casos_reabrir_com_divida: ja aplicado';
    return;
  end if;
  if v_md5 <> '63deeb34b039b9260c0d224b73d9ec81' then
    raise exception 'MD5_INESPERADO em casos_reabrir_com_divida: % (esperado 63deeb34b039b9260c0d224b73d9ec81)', v_md5;
  end if;

  v_velho := $velho$       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'$velho$;
  v_novo  := $novo$       -- 26/10/2026: congelado nao e tentado. Antes, ele era reaberto e o
       -- recalculo fechava de novo na mesma passagem, deixando um
       -- REABERTURA_DIVIDA_NOVA para um caso que nao reabriu.
       and not public.caso_encerramento_congelado(c.id)
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'$novo$;

  if position(v_velho in v_def) = 0 then
    raise exception 'ANCORA_NAO_ENCONTRADA em casos_reabrir_com_divida';
  end if;
  execute replace(v_def, v_velho, v_novo);
end;
$patch$;

commit;

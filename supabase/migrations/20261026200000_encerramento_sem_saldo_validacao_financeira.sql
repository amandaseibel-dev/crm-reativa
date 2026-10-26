-- ENCERRAMENTO OPERACIONAL: O TEXTO DEIXA DE VALER COMO PROVA DE SALDO ZERO
--
-- O problema, medido em producao em 26/10/2026. `caso_encerrado_operacional` e
-- o predicado que ~41 funcoes consultam para saber se um caso esta fora da
-- operacao. Ele decide em quatro linhas:
--
--   linha 1: bloqueio institucional (JURIDICO/CANCELAMENTO/SUSPENSAO) -> true
--   linha 2: texto 'SEM SALDO EM ABERTO'      -> true   SEM olhar dinheiro
--   linha 3: texto 'SALDO ZERO CONFIRMADO'    -> true   SEM olhar dinheiro
--   linha 4: texto de quitacao E saldo_titulos_aberto(p_cpf) = 0 -> true
--
-- As linhas 2 e 3 sao um desvio por cima de uma conferencia que a propria
-- funcao ja tem na linha 4 -- onde 'SEM SALDO EM ABERTO' JA ESTA na lista de
-- textos. Resultado medido: 2.895 casos carregam o texto, e em 27 deles ha
-- divida real (R$ 81.830,35; 26 pela medicao da gestao, que exclui um caso que
-- a linha 1 ja segura). As tres funcoes da area discordam sobre essas 27
-- linhas: a canonica `aluno_saldo_pendente_detalhe` diz que ha pendencia em
-- 27/27; `caso_saldo_zerado_real` (o que o ESCRITOR confere) diz zerado em
-- 0/27; e o predicado diz encerrado em 27/27. O lado que escreve esta correto:
-- o defeito e inteiro do lado que le.
--
-- O QUE ESTA MIGRATION FAZ (tudo aditivo; nenhum caso, aluno ou titulo e
-- alterado):
--   1. `caso_encerramento_sem_saldo` -- trilha APPEND-ONLY do encerramento por
--      ausencia de saldo, com data, responsavel, justificativa e ESTADO
--      ANTERIOR. Imutavel por gatilho.
--   2. CONGELAMENTO, calculado aqui dentro: antes de trocar a regra, grava um
--      registro para TODO caso cuja resposta mudaria. Com o registro vigente o
--      predicado continua respondendo "encerrado", entao NADA se move -- nem
--      carteira, nem distribuicao, nem acao massiva.
--   3. O predicado passa a exigir conferencia: as linhas 2 e 3 saem e os dois
--      textos passam pela linha 4. `'SALDO ZERO CONFIRMADO'` entra no array
--      `quit` (hoje nao esta lá -- sem isso o texto perderia efeito em vez de
--      passar a ser conferido). A linha 1 fica INTACTA.
--   4. Sobrecarga com `aluno_id`, que confere pela fonte CANONICA. Medido: o
--      portao por CPF erra em 21 casos (54 casos do atalho tem CPF vazio ou
--      00000000000, e para eles `saldo_titulos_aberto` devolve 0 para qualquer
--      divida -- a conferencia fica vazia); pela canonica, erra 0.
--   5. `caso_encerramento_resolver` -- a gestao decide caso a caso, com
--      justificativa e autoria identificada. Devolver a cobranca e ato
--      explicito dela, nunca automatico, e recusa quando criaria um segundo
--      caso aberto para o mesmo aluno.
--
-- O QUE NAO FAZ: nao mexe em dinheiro, nao da baixa, nao altera status de caso
-- ou aluno, nao reabre nada, nao inventa autor nem data para o que ja estava
-- classificado (o registro legado declara o autor como desconhecido).

begin;

-- ---------------------------------------------------------------------------
-- 1. A trilha do encerramento por ausencia de saldo.
-- ---------------------------------------------------------------------------
create table if not exists public.caso_encerramento_sem_saldo (
  id                bigserial primary key,
  caso_id           uuid not null references public.casos(id) on delete cascade,
  aluno_id          uuid,
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
  constraint caso_encerramento_sem_saldo_classificacao_check check (classificacao in
    ('SEM_SALDO_CONFERIDO','BLOQUEIO_INSTITUCIONAL','NAO_ACIONAR','OUTRO_CASO_ATIVO',
     'LEGADO_NAO_CONFERIDO','MANTIDO_PELA_GESTAO','DEVOLVIDO_A_COBRANCA')),
  constraint caso_encerramento_sem_saldo_origem_check check (origem in ('ROTINA','GESTAO','MIGRATION'))
);

comment on table public.caso_encerramento_sem_saldo is
  'Trilha APPEND-ONLY do encerramento operacional por ausencia de saldo: data, responsavel, justificativa e estado anterior. Um registro VIGENTE (resolvido_em nulo) congela o caso: o predicado caso_encerrado_operacional segue respondendo "encerrado" para ele.';

-- Um registro vigente por caso. E tambem a trava de concorrencia: duas rotinas
-- que tentem congelar o mesmo caso ao mesmo tempo nao conseguem as duas.
create unique index if not exists caso_encerramento_sem_saldo_vigente_unico
  on public.caso_encerramento_sem_saldo (caso_id) where resolvido_em is null;

create index if not exists caso_encerramento_sem_saldo_caso_idx
  on public.caso_encerramento_sem_saldo (caso_id, registrado_em desc);

create index if not exists caso_encerramento_sem_saldo_pendente_idx
  on public.caso_encerramento_sem_saldo (classificacao, registrado_em desc)
  where resolvido_em is null;

-- Trilha e trilha: nao se corrige, nao se apaga. Resolver e gravar linha nova
-- e marcar `resolvido_em` -- e por isso o UPDATE de resolucao e permitido, mas
-- so nessas duas colunas e so de nulo para valor.
create or replace function public._caso_encerramento_sem_saldo_imutavel()
returns trigger
language plpgsql
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'TRILHA_IMUTAVEL: a trilha do encerramento por ausencia de saldo nao aceita delete.'
      using errcode = '42501';
  end if;
  if old.resolvido_em is not null then
    raise exception 'TRILHA_IMUTAVEL: o registro % ja foi resolvido em % e nao muda mais.', old.id, old.resolvido_em
      using errcode = '42501';
  end if;
  if new.caso_id is distinct from old.caso_id
     or new.aluno_id is distinct from old.aluno_id
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
-- TRUNCATE, que RLS nao cobre. Aqui a gestao LE e mais nada; quem escreve sao
-- as funcoes SECURITY DEFINER desta migration.
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
-- 2. O congelamento esta vigente para este caso?
-- ---------------------------------------------------------------------------
create or replace function public.caso_encerramento_congelado(p_caso_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.caso_encerramento_sem_saldo e
                  where e.caso_id = p_caso_id and e.resolvido_em is null);
$function$;

grant execute on function public.caso_encerramento_congelado(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. CONGELAMENTO, calculado ANTES de trocar a regra.
--
-- Roda com o predicado ANTIGO ainda no lugar: grava um registro para todo caso
-- que hoje e "encerrado" e que deixaria de ser com a regra nova. Por isso a
-- resposta do predicado nao muda para ninguem no dia da aplicacao.
--
-- NAO INVENTA INFORMACAO AUSENTE: quem classificou o caso originalmente e
-- quando nao esta registrado em lugar nenhum (nos 2.895 casos do atalho, zero
-- tem linha em `auditoria`; `caso_atualizado_em` nao serve, porque
-- `recalcular_situacao_aluno` toca casos ja encerrados). Entao `decidido_por` e
-- `decidido_em` ficam NULOS e a justificativa diz isso com palavras.
-- ---------------------------------------------------------------------------
do $congelar$
declare
  v_quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                         'SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO',
                         'ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO',
                         'SALDO ZERO CONFIRMADO'];
  v_bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO','SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  v_bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO','SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  v_n int;
begin
  insert into public.caso_encerramento_sem_saldo
    (caso_id, aluno_id, classificacao, saldo_no_momento, estado_anterior, justificativa,
     decidido_por, decidido_em, origem, evidencia)
  select c.id, c.aluno_id,
         case
           when array[public.normalizar_status_acionamento(coalesce(c.status_atual,'')),
                      public.normalizar_status_acionamento(coalesce(c.status_financeiro,'')),
                      public.normalizar_status_acionamento(coalesce(c.status_jornada,''))] && v_bloq
             or array[public.normalizar_status_acionamento(coalesce(c.status_acionamento,''))] && v_bloq_acion
             then 'BLOQUEIO_INSTITUCIONAL'
           when coalesce(c.nao_acionar, false) then 'NAO_ACIONAR'
           when exists (select 1 from public.casos c2 where c2.aluno_id = c.aluno_id and c2.id <> c.id
                         and not coalesce(c2.encerrado_operacional, false)) then 'OUTRO_CASO_ATIVO'
           else 'LEGADO_NAO_CONFERIDO'
         end,
         round(coalesce((public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric, 0), 2),
         jsonb_build_object(
           'status_atual', c.status_atual, 'status_acionamento', c.status_acionamento,
           'status_financeiro', c.status_financeiro, 'status_jornada', c.status_jornada,
           'encerrado_operacional', c.encerrado_operacional, 'nao_acionar', c.nao_acionar,
           'operador_email', c.operador_email, 'caso_atualizado_em', c.caso_atualizado_em,
           'caso_atualizado_por', c.caso_atualizado_por),
         'Congelado na migration 20261026200000, antes de a regra passar a exigir conferencia financeira. '
         || 'O caso continua encerrado como estava. Quem o classificou originalmente e quando NAO consta em '
         || 'nenhum registro do sistema, portanto o autor e a data da decisao original ficam em branco de '
         || 'proposito, em vez de serem supostos. A gestao decide caso a caso por caso_encerramento_resolver.',
         null, null, 'MIGRATION',
         jsonb_build_object(
           'saldo_canonico', public.aluno_saldo_pendente_detalhe(c.aluno_id),
           'saldo_pela_funcao_por_cpf', public.saldo_titulos_aberto(c.cpf_limpo),
           'cpf_utilizavel', coalesce(c.cpf_limpo,'') not in ('','00000000000'),
           'resposta_antiga_do_predicado', true)
    from public.casos c
   where public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada)
     -- ... e que a regra NOVA nao sustentaria: nem bloqueio, nem saldo zero
     and not (array[public.normalizar_status_acionamento(coalesce(c.status_atual,'')),
                    public.normalizar_status_acionamento(coalesce(c.status_financeiro,'')),
                    public.normalizar_status_acionamento(coalesce(c.status_jornada,''))] && v_bloq
              or array[public.normalizar_status_acionamento(coalesce(c.status_acionamento,''))] && v_bloq_acion)
     and not (array[public.normalizar_status_acionamento(coalesce(c.status_atual,'')),
                    public.normalizar_status_acionamento(coalesce(c.status_acionamento,'')),
                    public.normalizar_status_acionamento(coalesce(c.status_financeiro,'')),
                    public.normalizar_status_acionamento(coalesce(c.status_jornada,''))] && v_quit
              and coalesce(public.saldo_titulos_aberto(c.cpf_limpo), 0) = 0)
  on conflict do nothing;

  get diagnostics v_n = row_count;
  raise notice 'congelamento: % caso(s) com registro vigente', v_n;
end;
$congelar$;

-- ---------------------------------------------------------------------------
-- 4. O predicado passa a exigir conferencia. Linha 1 intacta.
-- ---------------------------------------------------------------------------

-- A conferencia de verdade, num lugar so. Quando o aluno e conhecido usa a
-- fonte CANONICA; sem aluno, cai na funcao por CPF, que e o que a linha 4 ja
-- usava -- e cujo limite esta medido no comentario do topo.
create or replace function public._caso_sem_saldo_conferido(p_aluno_id uuid, p_cpf text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
    when p_aluno_id is not null
      then coalesce((public.aluno_saldo_pendente_detalhe(p_aluno_id)->>'total')::numeric, 0) <= 0.005
    else coalesce(public.saldo_titulos_aberto(p_cpf), 0) = 0
  end;
$function$;

grant execute on function public._caso_sem_saldo_conferido(uuid,text) to authenticated, service_role;

-- Sobrecarga com identidade: e a que os consumidores devem passar a chamar,
-- porque so ela consegue conferir pela fonte canonica e consultar o
-- congelamento.
create or replace function public.caso_encerrado_operacional(
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
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- 'SALDO ZERO CONFIRMADO' entra aqui: ele tinha linha propria sem conferencia
  -- e nao estava neste array, entao tira-lo da linha propria sem acrescentar
  -- aqui o faria perder efeito em vez de passar a ser conferido.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                       'SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO',
                       'ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO',
                       'SALDO ZERO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  -- linha 1, intacta: suspensao, cancelamento e juridico saem da operacao
  -- independentemente de dinheiro.
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;

  -- congelamento: decisao antiga preservada enquanto a gestao nao resolver.
  if p_caso_id is not null and public.caso_encerramento_congelado(p_caso_id) then return true; end if;

  -- o texto agora precisa de conferencia financeira.
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit))
     and public._caso_sem_saldo_conferido(p_aluno_id, p_cpf) then return true; end if;

  return false;
end;
$function$;

grant execute on function public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. A assinatura ANTIGA (5 argumentos), que os ~41 consumidores chamam.
--
-- Ela nao recebe o caso nem o aluno, entao: (a) o congelamento e resolvido pelo
-- CPF -- se QUALQUER caso daquele CPF tem registro vigente, responde
-- "encerrado", que e o lado seguro; (b) a conferencia continua sendo a por CPF,
-- com o limite ja medido (54 casos do atalho tem CPF vazio). Consumidor que
-- queira precisao passa a chamar a sobrecarga de 7 argumentos.
-- ---------------------------------------------------------------------------
do $patch$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'caso_encerrado_operacional'
     and pg_get_function_identity_arguments(p.oid) = 'p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text';
  if v_md5 is null then
    raise exception 'FUNCAO_AUSENTE: caso_encerrado_operacional(5 args)';
  end if;
  if v_md5 = 'b0a4a1b2c3d4e5f60718293a4b5c6d7e' then
    raise notice 'ja aplicado';
    return;
  end if;
  if v_md5 <> 'adc514c7a018018d866096d8e420d7b3' then
    raise exception 'MD5_INESPERADO em caso_encerrado_operacional(5 args): % (esperado adc514c7a018018d866096d8e420d7b3)', v_md5;
  end if;
end;
$patch$;

create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
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
  -- 26/10/2026: 'SALDO ZERO CONFIRMADO' entrou aqui. Ele tinha linha propria,
  -- sem conferencia, e nao estava neste array -- tira-lo da linha propria sem
  -- acrescentar aqui o faria perder efeito em vez de passar a ser conferido.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO',
                       'SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO',
                       'ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO',
                       'SALDO ZERO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g'), 11, '0');
begin
  -- linha 1, INTACTA.
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;

  -- 26/10/2026: as duas linhas que davam `return true` pelos textos
  -- 'SEM SALDO EM ABERTO' e 'SALDO ZERO CONFIRMADO' SEM olhar dinheiro sairam
  -- daqui. O congelamento preserva as decisoes que existiam antes da troca.
  if regexp_replace(coalesce(p_cpf,''), '\D', '', 'g') <> ''
     and exists (select 1 from public.casos c
                   join public.caso_encerramento_sem_saldo e on e.caso_id = c.id and e.resolvido_em is null
                  where lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D', '', 'g'), 11, '0') = v_cpf)
    then return true; end if;

  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit))
     and public._caso_sem_saldo_conferido(null, p_cpf) then return true; end if;

  return false;
end;
$function$;

grant execute on function public.caso_encerrado_operacional(text,text,text,text,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. A gestao resolve caso a caso. Devolver a cobranca e ato explicito dela.
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

  select * into v_e from public.caso_encerramento_sem_saldo
   where caso_id = p_caso_id and resolvido_em is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'SEM_REGISTRO_VIGENTE', 'caso_id', p_caso_id);
  end if;

  select * into v_c from public.casos where id = p_caso_id for update;
  if not found then
    raise exception 'CASO_NAO_ENCONTRADO';
  end if;

  v_saldo := round(coalesce((public.aluno_saldo_pendente_detalhe(v_c.aluno_id)->>'total')::numeric, 0), 2);

  -- DUPLICIDADE: devolver um caso a cobranca quando o aluno ja tem outro caso
  -- aberto criaria duas frentes de cobranca para a mesma pessoa. E a trava que
  -- `casos_reabrir_com_divida` ja aplica; aqui ela vale tambem para a decisao
  -- manual, senao a porta da gestao seria mais frouxa que a da rotina.
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

  -- MANTER_ENCERRADO grava registro novo e vigente: o congelamento continua,
  -- agora com autor, data e justificativa de verdade.
  if p_decisao = 'MANTER_ENCERRADO' then
    insert into public.caso_encerramento_sem_saldo
      (caso_id, aluno_id, classificacao, saldo_no_momento, estado_anterior, justificativa,
       decidido_por, decidido_em, origem, evidencia)
    values (p_caso_id, v_c.aluno_id, 'MANTIDO_PELA_GESTAO', v_saldo,
            jsonb_build_object(
              'status_atual', v_c.status_atual, 'status_acionamento', v_c.status_acionamento,
              'status_financeiro', v_c.status_financeiro, 'status_jornada', v_c.status_jornada,
              'encerrado_operacional', v_c.encerrado_operacional, 'nao_acionar', v_c.nao_acionar),
            v_just, v_email, now(), 'GESTAO',
            jsonb_build_object('registro_anterior', v_e.id, 'classificacao_anterior', v_e.classificacao));
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CASO_ENCERRAMENTO_SEM_SALDO_RESOLVIDO', 'casos', p_caso_id,
          jsonb_build_object('decisao', p_decisao, 'justificativa', v_just,
                             'classificacao_anterior', v_e.classificacao,
                             'saldo_no_momento', v_saldo, 'registro', v_e.id));

  -- NAO reabre nada aqui. DEVOLVER_A_COBRANCA so retira o congelamento; quem
  -- devolve e `casos_reabrir_com_divida`, que mantem as travas de `nao_acionar`,
  -- `cobranca_nao_reabrir`, bloqueio institucional e caso duplicado.
  return jsonb_build_object('ok', true, 'decisao', p_decisao, 'caso_id', p_caso_id,
                            'saldo_no_momento', v_saldo,
                            'congelamento', case when p_decisao = 'MANTER_ENCERRADO' then 'RENOVADO' else 'RETIRADO' end);
end;
$function$;

grant execute on function public.caso_encerramento_resolver(uuid,text,text) to authenticated, service_role;

-- Leitura da fila de pendencias, para a gestao.
create or replace function public.caso_encerramento_pendentes(p_limite integer default 200)
returns table(caso_id uuid, aluno_id uuid, aluno_nome text, classificacao text,
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
  select e.caso_id, e.aluno_id, al.nome, e.classificacao, e.saldo_no_momento, e.estado_anterior, e.registrado_em
    from public.caso_encerramento_sem_saldo e
    left join public.alunos al on al.id = e.aluno_id
   where e.resolvido_em is null
   order by e.saldo_no_momento desc nulls last, e.registrado_em
   limit greatest(coalesce(p_limite, 200), 1);
end;
$function$;

grant execute on function public.caso_encerramento_pendentes(integer) to authenticated, service_role;

commit;

-- CASOS ESSENCIAIS -- rodam DEPOIS da proposta aplicada, no banco isolado.
--
-- Cada caso FALHA FECHADO: `raise exception` derruba o psql (ON_ERROR_STOP) e
-- o CI fica vermelho. Nao existe teste que passa "mais ou menos" aqui.
--
-- O que NAO se prova aqui: comportamento de tela. Isso esta nos testes de
-- interface, que nao valem como prova de gravacao e nao sao citados como tal.

\set ON_ERROR_STOP on

create or replace function public.t_faixa(p text) returns text language sql stable as $$
  select faixa from public.carteira_2026_2_classificar() where documento = p;
$$;
create or replace function public.t_sub(p text) returns text language sql stable as $$
  select sub_faixa from public.carteira_2026_2_classificar() where documento = p;
$$;
create or replace function public.t_saldo() returns numeric language sql stable as $$
  select round(coalesce(sum(saldo),0),2) from public.carteira_2026_2_classificar();
$$;
create or replace function public.t_igual(p_o text, p_e text, p_v text) returns void language plpgsql as $$
begin
  if p_o is distinct from p_e then
    raise exception 'FALHOU [%]: esperado "%", veio "%"', p_v, p_e, p_o;
  end if;
end $$;

-- Recusa esperada. Devolve a mensagem do banco, ou null se NAO houve recusa.
-- Escrito assim de proposito: se o "raise" de falha ficasse dentro do bloco
-- exception, ele seria capturado pelo proprio bloco e a mensagem de erro sairia
-- trocada -- um teste que falha pelo motivo errado e quase tao ruim quanto um
-- que nao falha.
create or replace function public.t_recusa(
  p_titulo uuid, p_just text, p_evid text, p_valor numeric, p_sit text, p_liq date)
returns text language plpgsql as $$
declare msg text;
begin
  perform public.carteira_conferir_em_aberto(p_titulo, p_just, p_evid, p_valor, p_sit, p_liq);
  return null;
exception when others then
  get stacked diagnostics msg = message_text;
  return msg;
end $$;

create or replace function public.t_recusou(p_msg text, p_esperado text, p_v text)
returns void language plpgsql as $$
begin
  if p_msg is null then
    raise exception 'FALHOU [%]: a gravacao foi ACEITA, e devia ter sido recusada com %', p_v, p_esperado;
  end if;
  if p_msg !~ p_esperado then
    raise exception 'FALHOU [%]: recusou pelo motivo errado -- esperado %, veio "%"', p_v, p_esperado, p_msg;
  end if;
end $$;

-- Quem esta operando. Gestao por padrao; cada caso troca quando precisa.
select set_config('teste.email','gestao@teste',false),
       set_config('teste.gestao','true',false),
       set_config('teste.role','authenticated',false);

\echo '--- 0. ESTADO INICIAL (antes de qualquer confirmacao) ---'
do $$
declare v_saldo numeric;
begin
  perform public.t_igual(public.t_faixa('1000001'),'EM_CONFERENCIA','T1 liquidado no Prime');
  perform public.t_igual(public.t_faixa('1000002'),'EM_CONFERENCIA','T2 sem confirmacao');
  perform public.t_igual(public.t_faixa('1000003'),'EM_CONFERENCIA','T3 caixa fora');
  perform public.t_igual(public.t_faixa('1000004'),'CONVERTIDO','T4 tem acordo');
  perform public.t_igual(public.t_faixa('1000005'),'EM_CONFERENCIA','T5 PAGO com diferenca zero');
  perform public.t_igual(public.t_faixa('1000006'),'EM_CONFERENCIA','T6 com REJEITADO na fila');
  perform public.t_igual(public.t_faixa('1000007'),'EM_CONFERENCIA','T7 sem linha no Prime');
  perform public.t_igual(public.t_faixa('1000008'),'SEM_NEGOCIACAO','T8 testemunha');
  v_saldo := public.t_saldo();
  perform public.t_igual(v_saldo::text,'36000.00','saldo inicial');
  raise notice 'ok: 8 titulos classificados como esperado, saldo 36000.00';
end $$;

\echo '--- 1. GESTAO REGISTRA UMA CONFIRMACAO VALIDA ---'
do $$
declare r jsonb; n int; v_saldo numeric;
begin
  r := public.carteira_conferir_em_aberto(
         '70000000-0000-4000-8000-000000000001',
         'Consultado na tela do Prime: boleto em aberto, sem baixa e sem acordo.',
         'Prime, consulta de 28/09/2026',
         1000, 'ABERTO', date '2026-09-20');
  perform public.t_igual((r->>'ok'),'true','RPC devolveu ok');

  -- gravou usuario, data, titulo, justificativa e evidencia
  select count(*) into n from public.titulo_conferido_em_aberto
   where titulo_id = '70000000-0000-4000-8000-000000000001'
     and conferido_por = 'gestao@teste' and conferido_em is not null
     and length(justificativa) >= 15 and length(evidencia_referencia) >= 3;
  perform public.t_igual(n::text,'1','registro gravado com autor, data e evidencia');

  -- auditoria na ficha
  select count(*) into n from public.aluno_movimentacoes
   where tipo = 'TITULO_CONFERIDO_EM_ABERTO' and registrado_por_email = 'gestao@teste';
  perform public.t_igual(n::text,'1','auditoria registrada na ficha');

  -- o titulo mudou de faixa, com sub-faixa propria
  perform public.t_igual(public.t_faixa('1000001'),'SEM_NEGOCIACAO','T1 apos conferir');
  perform public.t_igual(public.t_sub('1000001'),
    'Conferido no Prime: em aberto, sem pagamento nem negociação','sub-faixa de T1');

  -- SO o titulo esperado mudou
  perform public.t_igual(public.t_faixa('1000002'),'EM_CONFERENCIA','T2 nao pode mexer');
  perform public.t_igual(public.t_faixa('1000003'),'EM_CONFERENCIA','T3 nao pode mexer');
  perform public.t_igual(public.t_faixa('1000005'),'EM_CONFERENCIA','T5 nao pode mexer');
  perform public.t_igual(public.t_faixa('1000006'),'EM_CONFERENCIA','T6 nao pode mexer');
  perform public.t_igual(public.t_faixa('1000007'),'EM_CONFERENCIA','T7 nao pode mexer');
  perform public.t_igual(public.t_faixa('1000008'),'SEM_NEGOCIACAO','T8 testemunha intacta');

  -- SALDO PRESERVADO: o valor mudou de faixa, nao de tamanho
  v_saldo := public.t_saldo();
  perform public.t_igual(v_saldo::text,'36000.00','saldo apos conferir');
  select count(*) into n from public.carteira_2026_2_classificar()
   where documento='1000001' and recuperado = 0 and saldo = 1000;
  perform public.t_igual(n::text,'1','T1 segue com recuperado 0 e saldo 1000');
  raise notice 'ok: confirmacao valida registrada, so T1 mudou, saldo preservado';
end $$;

\echo '--- 2. USUARIO SEM PERMISSAO NAO CONSEGUE ---'
do $$
declare ok boolean := false;
begin
  perform set_config('teste.gestao','false',false);
  perform set_config('teste.role','authenticated',false);
  begin
    perform public.carteira_conferir_em_aberto(
      '70000000-0000-4000-8000-000000000002',
      'Tentativa de quem nao e gestao, tem de ser recusada.',
      'Prime, consulta de 28/09/2026', 2000, 'ABERTO', null);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FALHOU: usuario sem permissao conseguiu registrar'; end if;
  -- e nao deixou rastro
  if exists (select 1 from public.titulo_conferido_em_aberto
              where titulo_id = '70000000-0000-4000-8000-000000000002') then
    raise exception 'FALHOU: recusou mas gravou mesmo assim';
  end if;
  perform set_config('teste.gestao','true',false);
  raise notice 'ok: sem permissao recusa com 42501 e nao grava nada';
end $$;

\echo '--- 3. IMPEDIMENTOS: pagamento, acordo, decisao incompativel, estado alterado ---'
do $$
declare n_antes int; n_depois int;
begin
  select count(*) into n_antes from public.titulo_conferido_em_aberto;

  -- 3a. titulo PAGO com diferenca ZERO: NAO cai em CONVERTIDO pela ordem dos
  --     ramos, entao a trava explicita e a unica coisa entre ele e uma
  --     confirmacao errada. Existem 7 assim em producao.
  perform public.t_recusou(public.t_recusa('70000000-0000-4000-8000-000000000005',
    'Tentativa sobre titulo pago, tem de ser recusada.', 'Prime', 5000, 'PAGO', date '2026-09-20'),
    'TEM_PAGAMENTO', 'titulo PAGO');

  -- 3b. titulo com acordo
  perform public.t_recusou(public.t_recusa('70000000-0000-4000-8000-000000000004',
    'Tentativa sobre titulo com acordo, tem de ser recusada.', 'Prime', 4000, 'ABERTO', null),
    'TEM_ACORDO', 'titulo com acordo');

  -- 3c. decisao incompativel na fila (bolsa / debito indevido)
  perform public.t_recusou(public.t_recusa('70000000-0000-4000-8000-000000000006',
    'Tentativa sobre titulo ja rejeitado, tem de ser recusada.', 'Prime', 6000, 'ABERTO', date '2026-09-20'),
    'DECISAO_EXISTENTE', 'titulo com REJEITADO na fila');

  -- 3d. estado alterado: valor diferente do que a tela exibiu
  perform public.t_recusou(public.t_recusa('70000000-0000-4000-8000-000000000002',
    'Tentativa com valor desatualizado, tem de ser recusada.', 'Prime', 1234, 'ABERTO', null),
    'ESTADO_MUDOU', 'valor desatualizado');

  -- 3e. estado alterado: liquidacao do Prime diferente da que a tela viu
  perform public.t_recusou(public.t_recusa('70000000-0000-4000-8000-000000000002',
    'Tentativa com liquidacao desatualizada, tem de ser recusada.', 'Prime', 2000, 'ABERTO', date '2026-01-01'),
    'ESTADO_MUDOU', 'liquidacao desatualizada');

  -- 3f. justificativa curta
  perform public.t_recusou(public.t_recusa('70000000-0000-4000-8000-000000000002',
    'curto', 'Prime', 2000, 'ABERTO', null),
    'JUSTIFICATIVA_OBRIGATORIA', 'justificativa curta');

  -- 3g. evidencia vazia
  perform public.t_recusou(public.t_recusa('70000000-0000-4000-8000-000000000002',
    'Justificativa longa o suficiente para passar.', '', 2000, 'ABERTO', null),
    'EVIDENCIA_OBRIGATORIA', 'evidencia vazia');

  select count(*) into n_depois from public.titulo_conferido_em_aberto;
  perform public.t_igual(n_depois::text, n_antes::text, 'nenhuma recusa gravou nada');
  raise notice 'ok: pagamento, acordo, decisao incompativel e estado alterado recusados';
end $$;

\echo '--- 4. EVIDENCIA POSTERIOR INVALIDA A CONFIRMACAO ---'
do $$
declare v_saldo numeric;
begin
  -- 4a. LIQUIDACAO NOVA no Prime: o titulo volta para a conferencia
  update public.prime_titulo_semestre set liquidado_em = '2026-09-25' where boleto = '1000001';
  perform public.t_igual(public.t_faixa('1000001'),'EM_CONFERENCIA','T1 apos liquidacao nova');
  perform public.t_igual(public.t_sub('1000001'),
    'Liquidado no Prime, origem não comprovada','T1 volta ao motivo de origem');

  -- volta ao estado conferido
  update public.prime_titulo_semestre set liquidado_em = '2026-09-20' where boleto = '1000001';
  perform public.t_igual(public.t_faixa('1000001'),'SEM_NEGOCIACAO','T1 volta a valer');

  -- 4b. ACORDO novo: a confirmacao NAO pode esconder -- vira CONVERTIDO
  insert into public.acordo_titulo_vinculo (titulo_id, acordo_id, ativo)
  values ('70000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001', true);
  perform public.t_igual(public.t_faixa('1000001'),'CONVERTIDO','T1 com acordo novo');
  delete from public.acordo_titulo_vinculo where titulo_id = '70000000-0000-4000-8000-000000000001';
  perform public.t_igual(public.t_faixa('1000001'),'SEM_NEGOCIACAO','T1 sem o acordo de novo');

  -- 4c. PAGAMENTO: situacao vira PAGO com diferenca ZERO. Nao cai em
  --     CONVERTIDO pela ordem dos ramos -- e a validade que impede a
  --     confirmacao de esconder o pagamento.
  update public.acordos_titulos set situacao = 'PAGO'
   where id = '70000000-0000-4000-8000-000000000001';
  perform public.t_igual(public.t_faixa('1000001'),'EM_CONFERENCIA','T1 PAGO nao fica em SEM_NEGOCIACAO');
  update public.acordos_titulos set situacao = 'ABERTO'
   where id = '70000000-0000-4000-8000-000000000001';

  -- 4d. PAGAMENTO com diferenca: vira CONVERTIDO, como tem de ser
  update public.acordos_titulos set situacao = 'PAGO', saldo_corrigido = 0
   where id = '70000000-0000-4000-8000-000000000001';
  perform public.t_igual(public.t_faixa('1000001'),'CONVERTIDO','T1 pago de verdade');
  update public.acordos_titulos set situacao = 'ABERTO', saldo_corrigido = 1000
   where id = '70000000-0000-4000-8000-000000000001';

  -- 4e. VALOR alterado: a assinatura cai
  update public.acordos_titulos set valor_original = 1111
   where id = '70000000-0000-4000-8000-000000000001';
  perform public.t_igual(public.t_faixa('1000001'),'EM_CONFERENCIA','T1 com valor diferente do conferido');
  update public.acordos_titulos set valor_original = 1000
   where id = '70000000-0000-4000-8000-000000000001';

  -- o registro NAO foi apagado por nada disso: e historico
  if not exists (select 1 from public.titulo_conferido_em_aberto
                  where titulo_id = '70000000-0000-4000-8000-000000000001') then
    raise exception 'FALHOU: o registro sumiu -- ele e historico, nao pode ser apagado';
  end if;

  v_saldo := public.t_saldo();
  perform public.t_igual(v_saldo::text,'36000.00','saldo no fim de tudo');
  raise notice 'ok: liquidacao nova, acordo, pagamento e valor novo derrubam a confirmacao';
end $$;

\echo '--- 5. PERMISSOES DEPOIS DA MIGRATION ---'
do $$
declare v_acl aclitem[];
begin
  select proacl into v_acl from pg_proc
   where pronamespace='public'::regnamespace and proname='carteira_2026_2_classificar';
  if v_acl is null then raise exception 'FALHOU: proacl nulo no classificador'; end if;
  if exists (select 1 from aclexplode(v_acl) a where a.privilege_type='EXECUTE'
              and coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC')
                  in ('PUBLIC','anon','authenticated')) then
    raise exception 'FALHOU: classificador aberto depois da migration';
  end if;

  select proacl into v_acl from pg_proc
   where pronamespace='public'::regnamespace and proname='carteira_conferir_em_aberto';
  if not exists (select 1 from aclexplode(v_acl) a where a.privilege_type='EXECUTE'
                  and a.grantee::regrole::text='authenticated') then
    raise exception 'FALHOU: a RPC nao esta disponivel para authenticated -- o botao nao funcionaria';
  end if;
  if exists (select 1 from aclexplode(v_acl) a where a.privilege_type='EXECUTE'
              and coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC') in ('PUBLIC','anon')) then
    raise exception 'FALHOU: a RPC esta aberta para anon ou PUBLIC';
  end if;

  if exists (select 1 from information_schema.role_table_grants
              where table_schema='public' and table_name='titulo_conferido_em_aberto'
                and grantee in ('PUBLIC','anon','authenticated')) then
    raise exception 'FALHOU: a tabela esta exposta a anon/authenticated';
  end if;
  raise notice 'ok: classificador fechado, RPC so para authenticated, tabela fechada';
end $$;

\echo ''
\echo '================ TODOS OS CASOS PASSARAM ================'

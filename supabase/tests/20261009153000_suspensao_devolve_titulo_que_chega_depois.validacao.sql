-- VALIDACAO de 20261009153000_suspensao_devolve_titulo_que_chega_depois.sql
--
-- COMO RODAR: cole inteiro numa sessao SQL do projeto de PRODUCAO
-- (ahattpqrjmhkzsmnbdzs). O arquivo ABRE e ABORTA a transacao: o `rollback` do
-- fim desfaz TUDO -- as duas funcoes, o gatilho e cada escrita de teste. Nada
-- fica gravado. Rodar duas vezes da o mesmo resultado.
--
-- Aluna de teste: Jessica Linck `e07f8053-62f4-4363-ae1f-0b445ab620ed`, medida
-- em 09/10/2026 com 3 titulos EM_CONFIRMACAO (R$ 2.118,30) e 1 ABERTO
-- (R$ 1.138,33, titulo `56790385`).
--
-- O QUE CADA ETAPA PROVA:
--   01  previa no escopo de um aluno          -> 3 a devolver, o ABERTO preservado
--   02  previa no escopo de todos             -> 34 alunos, 59 titulos, R$ 68.944,38
--   03  retroativo REAL na Jessica            -> 3 devolvidos, sem abortar
--   04  estado dos 4 titulos dela             -> 3 DEVOLVIDO/devolvido com
--                                               devolucao_origem = SUSPENSAO_COBRANCA,
--                                               devolucao_situacao_anterior = EM_CONFIRMACAO,
--                                               origem_encerramento NULO,
--                                               valor_em_aberto 0; o ABERTO INTACTO
--   05  Conferencia Prime                     -> as 3 pendencias viram DEVOLVIDO
--   06  O GATILHO, que e o furo desta rodada  -> mover o titulo ABERTO dela para
--                                               EM_CONFIRMACAO (o que a rotina da
--                                               Prime faz) o deixa DEVOLVIDO na hora
--   07  REGRESSAO CRITICA: levantar a suspensao
--                                             -> `suspensao_cobranca_reativar`
--                                               restaura os 4 titulos e NAO aborta.
--       Esta e a etapa que importa: a reativacao restaura o titulo para
--       EM_CONFIRMACAO ANTES de limpar o status do aluno. Sem a guarda
--       `parcela_efeito_sem_pagamento.aplicando = on` no gatilho, ele devolveria
--       o titulo de novo no mesmo instante e a TRAVA final da reativacao
--       ("titulo continua DEVOLVIDO por SUSPENSAO_COBRANCA") abortaria TUDO.
--   08  integridade financeira                -> pagamentos, acordos, parcelas,
--                                               vinculos, baixas e a soma de
--                                               honorarios identicos ao inicio
--
-- LEIA O RESULTADO: a ultima consulta lista etapa por etapa. Se qualquer etapa
-- levantar excecao, a transacao aborta sozinha e NADA do arquivo foi gravado --
-- e o erro e a resposta.

begin;

-- ===========================================================================
-- A ESTRUTURA DA MIGRATION (sem os blocos de comentario; o porque mora no
-- arquivo de supabase/migrations/)
-- ===========================================================================
create or replace function public._titulo_sob_suspensao_devolve()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
declare v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
begin
  if coalesce(current_setting('parcela_efeito_sem_pagamento.aplicando', true), '') = 'on' then return null; end if;
  if public.aluno_bloqueio_administrativo(new.aluno_id) is distinct from 'SUSPENSAO_COBRANCA' then return null; end if;
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (coalesce(nullif(lower(coalesce(auth.jwt() ->> 'email','')),''), 'desconhecido'),
            'TITULO_EM_CONFIRMACAO_SOB_SUSPENSAO_NAO_DEVOLVIDO', 'acordos_titulos', new.id,
            jsonb_build_object('aluno_id', new.aluno_id, 'documento', new.documento,
                               'por_que', 'quem registrou nao e gestao nem sistema; recolher com suspensao_cobranca_devolver_em_confirmacao'));
    return null;
  end if;
  perform public.titulo_devolver_da_confirmacao(new.id, 'SUSPENSAO_COBRANCA',
    'Titulo entrou em confirmacao com a cobranca do aluno JA suspensa (SUSPENSAO_COBRANCA). A suspensao finalizou o caso: nao ha o que confirmar e nao ha recuperacao da ReATIVA.');
  return null;
end; $f$;

drop trigger if exists trg_titulo_sob_suspensao_devolve on public.acordos_titulos;
create trigger trg_titulo_sob_suspensao_devolve
  after insert or update of situacao on public.acordos_titulos
  for each row when (upper(coalesce(new.situacao,'')) = 'EM_CONFIRMACAO')
  execute function public._titulo_sob_suspensao_devolve();

create or replace function public.suspensao_cobranca_devolver_em_confirmacao(
  p_motivo text, p_aluno_id uuid default null, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path to 'public' as $f$
declare
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_qtd int := 0; v_val numeric := 0; v_alunos int := 0;
  v_pres_qtd int := 0; v_pres_val numeric := 0; v_ign int := 0;
  v_t record; v_res jsonb;
begin
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Devolver titulo por suspensao e decisao da gestao. Registre a solicitacao para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio: a devolucao precisa dizer o que a gestao autorizou e quando.'
      using errcode = '22023';
  end if;
  select count(*), coalesce(sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2)),0)
    into v_pres_qtd, v_pres_val from public.acordos_titulos t
   where (p_aluno_id is null or t.aluno_id = p_aluno_id)
     and upper(coalesce(t.situacao,'')) <> 'EM_CONFIRMACAO'
     and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA';
  if p_dry_run then
    select count(*), count(distinct t.aluno_id),
           coalesce(sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2)),0)
      into v_qtd, v_alunos, v_val from public.acordos_titulos t
     where (p_aluno_id is null or t.aluno_id = p_aluno_id)
       and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
       and coalesce(t.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL'
       and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA';
    return jsonb_build_object('ok', true, 'dry_run', true, 'alunos', v_alunos,
      'titulos_a_devolver_qtd', v_qtd, 'titulos_a_devolver_valor', round(v_val,2),
      'titulos_preservados_qtd', v_pres_qtd, 'titulos_preservados_valor', round(v_pres_val,2));
  end if;
  for v_t in
    select t.id, t.aluno_id, round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2) as valor
      from public.acordos_titulos t
     where (p_aluno_id is null or t.aluno_id = p_aluno_id)
       and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
       and coalesce(t.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL'
       and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA'
     order by t.aluno_id, t.id
  loop
    v_res := public.titulo_devolver_da_confirmacao(v_t.id, 'SUSPENSAO_COBRANCA', btrim(p_motivo));
    if coalesce((v_res->>'ignorado')::boolean, false) then v_ign := v_ign + 1;
    else v_qtd := v_qtd + 1; v_val := v_val + coalesce(v_t.valor,0); end if;
  end loop;
  select count(distinct aluno_id) into v_alunos from public.acordos_titulos
   where (p_aluno_id is null or aluno_id = p_aluno_id)
     and upper(coalesce(situacao,'')) = 'DEVOLVIDO' and devolucao_origem = 'SUSPENSAO_COBRANCA';
  if exists (select 1 from public.acordos_titulos t
              where (p_aluno_id is null or t.aluno_id = p_aluno_id)
                and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
                and coalesce(t.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL'
                and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA') then
    raise exception 'TRAVA: sobrou titulo EM_CONFIRMACAO sob SUSPENSAO_COBRANCA depois do retroativo. Nada foi confirmado.'
      using errcode = 'P0001';
  end if;
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(lower(coalesce(auth.jwt() ->> 'email','')),''), 'sistema'),
          'SUSPENSAO_RETROATIVO_TITULOS_DEVOLVIDOS', 'acordos_titulos', null,
          jsonb_build_object('escopo', coalesce(p_aluno_id::text, 'todos os alunos sob suspensao'),
                             'titulos_devolvidos', v_qtd, 'valor', round(v_val,2),
                             'titulos_ignorados', v_ign, 'titulos_preservados', v_pres_qtd,
                             'motivo', btrim(p_motivo), 'sem_efeito_financeiro', true));
  return jsonb_build_object('ok', true, 'dry_run', false,
    'alunos_com_titulo_devolvido_por_suspensao', v_alunos,
    'titulos_devolvidos_qtd', v_qtd, 'titulos_devolvidos_valor', round(v_val,2),
    'titulos_ignorados_qtd', v_ign, 'titulos_preservados_qtd', v_pres_qtd,
    'titulos_preservados_valor', round(v_pres_val,2));
end; $f$;

-- ===========================================================================
-- AS ETAPAS
-- ===========================================================================
create temporary table _r(ord int, etapa text, dado jsonb) on commit drop;

insert into _r values (0,'00_integridade_antes', (select jsonb_build_object(
  'em_confirmacao',(select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO'),
  'devolvido',(select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='DEVOLVIDO'),
  'prime_pendente',(select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE'),
  'pagamentos',(select count(*) from public.pagamentos),'acordos',(select count(*) from public.acordos),
  'parcelas',(select count(*) from public.parcelas),'vinculos',(select count(*) from public.acordo_titulo_vinculo),
  'baixas',(select count(*) from public.baixas_pagamento),
  'honorarios',(select coalesce(sum(coalesce(honorarios,0)),0) from public.parcelas))));

insert into _r values (1,'01_previa_jessica',
  public.suspensao_cobranca_devolver_em_confirmacao('validacao', 'e07f8053-62f4-4363-ae1f-0b445ab620ed', true));

insert into _r values (2,'02_previa_global',
  public.suspensao_cobranca_devolver_em_confirmacao('validacao', null, true));

insert into _r values (3,'03_retroativo_real_jessica',
  public.suspensao_cobranca_devolver_em_confirmacao(
    'Retroativo 09/10/2026 autorizado pela gestao: suspensao de cobranca nao e recuperacao da ReATIVA.',
    'e07f8053-62f4-4363-ae1f-0b445ab620ed', false));

insert into _r values (4,'04_titulos_jessica', (select jsonb_agg(jsonb_build_object(
    'id',left(id::text,8),'sit',situacao,'st',status,'em_aberto',valor_em_aberto,
    'devolucao_origem',devolucao_origem,'veio_de',devolucao_situacao_anterior,
    'origem_encerramento',origem_encerramento) order by id)
  from public.acordos_titulos where aluno_id='e07f8053-62f4-4363-ae1f-0b445ab620ed'));

insert into _r values (5,'05_prime_jessica', (select jsonb_agg(jsonb_build_object(
    'titulo',left(titulo_id::text,8),'decisao',decisao) order by titulo_id)
  from public.prime_conferencia_decisao where aluno_id='e07f8053-62f4-4363-ae1f-0b445ab620ed'));

-- 06. O GATILHO. Reproduz o que `prime_liquidacao_suspender` faz com o titulo
-- ABERTO dela (`56790385`): entra em EM_CONFIRMACAO com a marca oficial. O
-- esperado e sair DEVOLVIDO na mesma transacao -- nao e preciso tabular de novo.
do $$
begin
  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos set situacao = 'EM_CONFIRMACAO', atualizado_em = now()
   where id = '56790385-6679-42a6-b487-ac6a40eac184';
  perform set_config('conferencia_prime.decisao', 'off', true);
end $$;

insert into _r values (6,'06_gatilho_titulo_que_chegou_depois', (select jsonb_build_object(
    'id',left(id::text,8),'sit',situacao,'st',status,'em_aberto',valor_em_aberto,
    'devolucao_origem',devolucao_origem,'veio_de',devolucao_situacao_anterior)
  from public.acordos_titulos where id='56790385-6679-42a6-b487-ac6a40eac184'));

-- 07. REGRESSAO CRITICA. Levantar a suspensao tem de continuar funcionando.
insert into _r values (7,'07_reativacao_nao_aborta',
  public.suspensao_cobranca_reativar('e07f8053-62f4-4363-ae1f-0b445ab620ed',
    'validacao: conferir que a reativacao restaura os titulos devolvidos pela suspensao', false));

insert into _r values (8,'08_titulos_depois_da_reativacao', (select jsonb_agg(jsonb_build_object(
    'id',left(id::text,8),'sit',situacao,'st',status,'devolucao_origem',devolucao_origem) order by id)
  from public.acordos_titulos where aluno_id='e07f8053-62f4-4363-ae1f-0b445ab620ed'));

insert into _r values (9,'09_integridade_depois', (select jsonb_build_object(
  'em_confirmacao',(select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO'),
  'devolvido',(select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='DEVOLVIDO'),
  'prime_pendente',(select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE'),
  'pagamentos',(select count(*) from public.pagamentos),'acordos',(select count(*) from public.acordos),
  'parcelas',(select count(*) from public.parcelas),'vinculos',(select count(*) from public.acordo_titulo_vinculo),
  'baixas',(select count(*) from public.baixas_pagamento),
  'honorarios',(select coalesce(sum(coalesce(honorarios,0)),0) from public.parcelas))));

select ord, etapa, jsonb_pretty(dado) as resultado from _r order by ord;

rollback;

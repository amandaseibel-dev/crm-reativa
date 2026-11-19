-- REPRODUCAO FIEL, no banco descartavel, do gatilho que bloqueia UPDATE de casos e das funcoes que ele usa,
-- e do gatilho de ultimo acionamento em aluno_movimentacoes (corpos copiados de pg_get_functiondef em producao,
-- leitura somente-SELECT de 19/11/2026). Cada objeto e conferido por md5 da definicao: se a copia divergir de
-- producao, o teste FALHA.
-- md5 de producao (coletado 2026-11-19 09:35 UTC):
--   bloquear_alteracoes_restritas_casos()        06edb22723aa1ee3206d1f495ec141cd  (dono postgres, invoker)
--   crm_usuario_acesso_restrito_amanda()         ff37a4b6df151b2a03a7ec174b166b6e  (dono postgres, invoker)
--   eh_tipo_acionamento(text)                    ee7f78b44625daba48a78601fa95a4f0  (dono postgres, invoker)
--   fn_atualizar_ultimo_acionamento()            400a73f7cf8402fab2f171ebe9e65c0a  (dono postgres, DEFINER)
--   trigger trg_bloquear_alteracoes_restritas_casos   49af8ba2fe92dea3ea13adf7181b9216
--   trigger trg_atualizar_ultimo_acionamento          701c5e95de01efb943acfe65b6474f63

\i lib.sql

CREATE OR REPLACE FUNCTION public.crm_usuario_acesso_restrito_amanda()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  email_logado text;
begin
  -- roles internas/administrativas: decidir sem depender do schema auth
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return true;
  end if;

  if current_user = 'reativa_responsavel_executor' then
    -- role interna das RPCs de responsável: NÃO é acesso irrestrito;
    -- mantém a proteção de colunas sensíveis (que passa nas mudanças operacionais).
    return false;
  end if;

  -- usuários normais (authenticated): comportamento original inalterado
  email_logado := lower(coalesce(auth.jwt() ->> 'email', ''));

  return email_logado in (
    'amanda.seibel@aelbra.com.br'
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.bloquear_alteracoes_restritas_casos()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if public.crm_usuario_acesso_restrito_amanda() then
    return new;
  end if;

  if new.valor_cobranca_ajustado is distinct from old.valor_cobranca_ajustado
    or new.motivo_ajuste_valor is distinct from old.motivo_ajuste_valor
    or new.valor_ajustado_por is distinct from old.valor_ajustado_por
    or new.valor_ajustado_em is distinct from old.valor_ajustado_em
    or new.cadastro_caso_observacao is distinct from old.cadastro_caso_observacao
    or new.caso_atualizado_por is distinct from old.caso_atualizado_por
    or new.caso_atualizado_em is distinct from old.caso_atualizado_em
    or new.status_financeiro is distinct from old.status_financeiro
    or new.origem_quitacao is distinct from old.origem_quitacao
    or new.quitado_em is distinct from old.quitado_em
    or new.valor_quitado is distinct from old.valor_quitado
    or new.baixa_importada_id is distinct from old.baixa_importada_id
    or new.observacao_financeira is distinct from old.observacao_financeira
  then
    raise exception 'Ação permitida somente para Amanda gestora.';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.eh_tipo_acionamento(p_tipo text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(p_tipo,'') in (
    'FINALIZACAO_ATENDIMENTO','FINALIZACAO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL','CONTATO',
    'LINK_ENVIADO_AO_ALUNO','SOLICITACAO_LINK_PAGAMENTO','COMPROVANTE_ENVIADO_BAIXA',
    'QUITADO_MANUAL','TERMO_ENVIADO_ADM','RETORNO_ADM_CRIADO','RETORNO_ADM_CONCLUIDO'
  );
$function$;

CREATE OR REPLACE FUNCTION public.fn_atualizar_ultimo_acionamento()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = (new.registrado_em at time zone 'America/Sao_Paulo')::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < (new.registrado_em at time zone 'America/Sao_Paulo')::date);

  if new.tipo not in ('ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL') then
    begin
      perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
    exception when others then
      null;
    end;
  end if;

  return new;
exception when others then
  return new;
end;
$function$;

CREATE TRIGGER trg_bloquear_alteracoes_restritas_casos BEFORE UPDATE ON public.casos FOR EACH ROW EXECUTE FUNCTION bloquear_alteracoes_restritas_casos();
CREATE TRIGGER trg_atualizar_ultimo_acionamento AFTER INSERT ON public.aluno_movimentacoes FOR EACH ROW EXECUTE FUNCTION fn_atualizar_ultimo_acionamento();

-- CONFERENCIA: a copia carregada tem o mesmo md5 de producao. Diverge -> falha.
do $$
declare r record; n int := 0; n_ok int := 0;
begin
  for r in
    select 'fn crm_usuario_acesso_restrito_amanda' as nome, md5(pg_get_functiondef('public.crm_usuario_acesso_restrito_amanda()'::regprocedure)) as md5, 'ff37a4b6df151b2a03a7ec174b166b6e' as prod
    union all select 'fn bloquear_alteracoes_restritas_casos', md5(pg_get_functiondef('public.bloquear_alteracoes_restritas_casos()'::regprocedure)), '06edb22723aa1ee3206d1f495ec141cd'
    union all select 'fn eh_tipo_acionamento', md5(pg_get_functiondef('public.eh_tipo_acionamento(text)'::regprocedure)), 'ee7f78b44625daba48a78601fa95a4f0'
    union all select 'fn fn_atualizar_ultimo_acionamento', md5(pg_get_functiondef('public.fn_atualizar_ultimo_acionamento()'::regprocedure)), '400a73f7cf8402fab2f171ebe9e65c0a'
    union all select 'trg trg_bloquear_alteracoes_restritas_casos', md5(pg_get_triggerdef((select oid from pg_trigger where tgname='trg_bloquear_alteracoes_restritas_casos'))), '49af8ba2fe92dea3ea13adf7181b9216'
    union all select 'trg trg_atualizar_ultimo_acionamento', md5(pg_get_triggerdef((select oid from pg_trigger where tgname='trg_atualizar_ultimo_acionamento'))), '701c5e95de01efb943acfe65b6474f63'
  loop
    n := n + 1;
    if r.md5 = r.prod then n_ok := n_ok + 1; end if;
    raise notice 'md5 %: ci=% prod=% %', r.nome, r.md5, r.prod, case when r.md5 = r.prod then 'IGUAL' else 'DIVERGE' end;
  end loop;
  perform pg_temp.afirma(n = 6 and n_ok = 6, format('gatilho casos e acionamento: %s/%s objetos iguais a producao (md5)', n_ok, n));
end $$;

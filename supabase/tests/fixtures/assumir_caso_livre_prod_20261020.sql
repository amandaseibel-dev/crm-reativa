-- COMPLEMENTO DE PRODUCAO para o teste de `assumir_caso_livre` -- 20/10/2026.
--
-- A fixture `fidelizacao_por_dono_prod_20260930.sql` ja traz, com o texto EXATO
-- de producao e md5 por corpo: as 21 tabelas (casos, usuarios, alunos,
-- historico_operadores_alunos, calibragem_parametros, parcelas, acordos,
-- solicitacoes_confirmacao_pagamento, links_pagamento, baixas_pagamento,
-- acordos_titulos), os 12 gatilhos de `casos` -- inclusive
-- `trigger_impor_teto_operador` -- e as guardas que decidem tudo:
-- `caso_protegido_redistribuicao`, `caso_encerrado_operacional`,
-- `caso_aguarda_confirmacao_financeira`, `saldo_titulos_aberto`,
-- `calibragem_teto_operador` e `internal.carteira_geral_email`.
--
-- Falta nela o que nasceu DEPOIS de 30/09: a coluna `casos.giro_fidelizacao_ate`
-- (giro de 16/10) e seis funcoes. Este arquivo completa, tambem com o texto
-- exato de producao, conferido por md5 em
-- `assumir_caso_livre_prod_20261020.md5.json`.
--
-- NENHUM DADO REAL: so estrutura e corpo de funcao.

-- A coluna do giro de 16/10. O corpo de `assumir_caso_livre` a le, entao sem ela
-- a funcao nem compila.
alter table public.casos add column if not exists giro_fidelizacao_ate date;

-- ===========================================================================
-- internal.nome_operador_ativo
-- ===========================================================================
CREATE OR REPLACE FUNCTION internal.nome_operador_ativo(p_email text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select u.nome from public.usuarios u
  where lower(u.email)=lower(p_email) and u.ativo=true
    and (
      u.perfil='operador'
      or lower(u.email) in (
        'cobranca07@aelbra.com.br',   -- Amanda ADM (ja existente)
        'amanda.seibel@aelbra.com.br',-- Amanda gestora
        'cobranca04@aelbra.com.br'    -- Fernanda supervisora
      )
    )
  limit 1;
$function$;

-- ===========================================================================
-- internal.operador_pode_receber_caso
-- ===========================================================================
CREATE OR REPLACE FUNCTION internal.operador_pode_receber_caso(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select internal.nome_operador_ativo(p_email) is not null
     and coalesce((select u.recebe_novos_casos
                     from public.usuarios u
                    where lower(u.email) = lower(btrim(coalesce(p_email,'')))
                    limit 1), false);
$function$;

-- ===========================================================================
-- internal.patch_funcao_ancorada -- o mecanismo que a migration usa
-- ===========================================================================
CREATE OR REPLACE FUNCTION internal.patch_funcao_ancorada(p_schema text, p_funcao text, p_ancora text, p_novo text, p_ocorrencias integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare v_src text; v_n int; v_ja int;
begin
  -- Patch ambiguo: se o texto novo e um PEDACO da ancora, ele ja aparece na
  -- funcao antes de qualquer troca e nao da para distinguir "ja aplicado" de
  -- "nunca aplicado". Recusa na entrada em vez de errar em silencio.
  if position(p_novo in p_ancora) > 0 and position(p_ancora in p_novo) = 0 then
    raise exception 'patch_funcao_ancorada: o texto novo e pedaco da ancora — patch ambiguo, reescreva a ancora.';
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_funcao
   limit 1;

  if v_src is null then
    raise exception 'patch_funcao_ancorada: %.% nao existe.', p_schema, p_funcao;
  end if;

  -- Idempotencia ANTES da contagem da ancora. Nos patches que so ACRESCENTAM
  -- (o texto novo contem a ancora), a ancora continua existindo depois de
  -- aplicado — entao contar ancora nao distingue nada. O que distingue e o
  -- texto NOVO ja estar la.
  v_ja := (length(v_src) - length(replace(v_src, p_novo, ''))) / length(p_novo);
  if v_ja >= p_ocorrencias then
    raise notice 'patch_funcao_ancorada: %.% ja estava aplicada.', p_schema, p_funcao;
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, p_ancora, ''))) / length(p_ancora);
  if v_n <> p_ocorrencias then
    raise exception 'patch_funcao_ancorada: %.% tem % ocorrencia(s) da ancora, esperado %. A funcao mudou; revise o patch.',
      p_schema, p_funcao, v_n, p_ocorrencias;
  end if;

  execute replace(v_src, p_ancora, p_novo);
end;
$function$;

-- ===========================================================================
-- public.caso_em_giro_fidelizacao
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.caso_em_giro_fidelizacao(p_ate date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select p_ate is not null
     and p_ate >= (now() at time zone 'America/Sao_Paulo')::date;
$function$;

-- ===========================================================================
-- public.nome_operador_por_email
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.nome_operador_por_email(p_email text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  e text;
begin
  e := lower(coalesce(p_email, ''));

  return case e
    when 'amanda.seibel@aelbra.com.br' then 'AMANDA GESTORA'
    when 'cobranca04@aelbra.com.br' then 'FERNANDA'
    when 'cobranca05@aelbra.com.br' then 'LUANA'
    when 'cobranca12@aelbra.com.br' then 'DIEGO'
    when 'cobranca13@aelbra.com.br' then 'RAFAELLA'
    when 'cobranca07@aelbra.com.br' then 'AMANDA ADM'
    when 'cobranca11@aelbra.com.br' then 'ALLAN'
    when 'cobranca06@aelbra.com.br' then 'MAURICIO'
    when 'cobranca03@aelbra.com.br' then 'OLGA'
    when 'cobranca10@aelbra.com.br' then 'JOAO'
    when 'cobranca08@aelbra.com.br' then 'NATALY'
    else upper(split_part(e, '@', 1))
  end;
end;
$function$;

-- ===========================================================================
-- public.assumir_caso_livre -- O ALVO. Corpo de producao em 20/10/2026,
-- md5(prosrc) = ae50c7d6476ddb0059211d20dd15889e
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.assumir_caso_livre(p_caso_id uuid)
 RETURNS TABLE(sucesso boolean, mensagem text, caso_liberado uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
declare
  v_email text; v_nome text; v_upper text; v_new record; v_new_saldo numeric; v_count int;
  v_rel record; v_liberado uuid := null;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  if v_email = '' then return query select false,'Usuario nao identificado. Faca login novamente.',null::uuid; return; end if;
  v_nome := public.nome_operador_por_email(v_email);
  if v_nome is null then return query select false,'Operador nao ativo ou nao identificado.',null::uuid; return; end if;
  if not internal.operador_pode_receber_caso(v_email) then return query select false,'Sua carteira esta fechada para casos novos. Fale com a gestao.',null::uuid; return; end if;
  v_upper := upper(v_nome);
  select c.*, public.saldo_titulos_aberto(c.cpf_limpo) AS _saldo into v_new
    from public.casos c where c.id = p_caso_id for update;
  if not found then return query select false,'Caso nao encontrado.',null::uuid; return; end if;
  if coalesce(v_new.operador_email,'') <> '' then
    if public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate) then
      return query select false,'Este caso está fidelizado pelo giro de carteira até 26/10/2026.',null::uuid; return;
    end if;
    if v_new.giro_fidelizacao_ate is null then
      return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
    end if;
    -- Caso de giro com a fidelizacao ja vencida: segue adiante e troca o dono.
  end if;
  if public.caso_protegido_redistribuicao(v_new.cpf_limpo,v_new.status_acionamento,v_new.nao_acionar,v_new.status_financeiro,v_new.valor_pago,v_new.quitado_em,v_new.valor_quitado)
     or public.caso_encerrado_operacional(v_new.cpf_limpo,v_new.status_atual,v_new.status_acionamento,v_new.status_financeiro,v_new.status_jornada)
     or coalesce(v_new._saldo,0) <= 0 then
    return query select false,'Caso nao elegivel (protegido, encerrado ou sem saldo).',null::uuid; return;
  end if;
  v_new_saldo := v_new._saldo;
  v_count := (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id));
  if v_count >= 500 then
    select c.id into v_rel from public.casos c
    where c.operador_email = v_email and c.ultima_tabulacao_em is null
      and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
      and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)
    order by abs(public.saldo_titulos_aberto(c.cpf_limpo) - v_new_saldo) asc, c.caso_atualizado_em desc nulls last
    limit 1 for update skip locked;
    if v_rel.id is null then
      return query select false,'Carteira cheia (500) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;
    end if;
    v_liberado := v_rel.id;
    update public.casos set operador_email=null, operador_nome=null, operador=null where id = v_liberado;
    insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_anterior_nome,operador_anterior_email,observacao,criado_em)
    select chave_unificacao,nome,cpf,'LIBERACAO_TROCA_ASSUMIR',v_nome,v_email,'Liberado por troca ao assumir caso '||p_caso_id::text||'.',now()
    from public.casos where id = v_liberado;
  end if;
  update public.casos set operador_email=v_email, operador_nome=v_nome, operador=v_upper,
    caso_atualizado_por=v_email, caso_atualizado_em=now()
  where id = p_caso_id;
  insert into public.historico_operadores_alunos (chave_unificacao,nome_aluno,cpf_referencia,acao,operador_nome,operador_email,observacao,criado_em)
  select chave_unificacao,nome,cpf,'ASSUMIR_ATENDIMENTO',v_nome,v_email,
    'Assumido caso livre. assumido_por='||v_email||' assumido_em='||now()::text||'. Fidelizacao inicia apenas apos acionamento valido.', now()
  from public.casos where id = p_caso_id;
  if (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id)) > 500 then
    raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.';
  end if;
  return query select true, 'Atendimento assumido. Acione dentro do prazo operacional para iniciar a fidelizacao de 10 dias.', v_liberado;
end;
$function$;

-- ============================================================================
-- Relatorio de projecao de fechamento por OPERADOR e VENCIMENTO (so gestao).
-- ----------------------------------------------------------------------------
-- Fonte: public.pagamentos (relatorio de pagamentos do Prime, layout Santander).
-- A coluna G do arquivo ("data referencia") e o VENCIMENTO da parcela e a
-- coluna H o valor original; a importacao passou a guarda-los dentro de
-- `dados` ('vencimento' / 'valor_original'). Pagamentos importados ANTES
-- dessa mudanca nao tem vencimento (aparecem como SEM_VENCIMENTO) -- para
-- preencher, basta reenviar o arquivo do mes via "Substituir importacao".
--
-- Filtros: operadores (null = todos; aceita o marcador 'SEM_OPERADOR') e
-- faixa de vencimento (p_venc_de/p_venc_ate; null = todos). Situacao de cada
-- pagamento: ADIANTADO / EM_DIA / ATRASADO / SEM_VENCIMENTO.
-- Acesso: EXCLUSIVO gestao (Amanda e Fernanda), mesmo gate dos demais
-- relatorios da Projecao. Paginada (max 500 por pagina).
-- ============================================================================

create or replace function public.projecao_relatorio_pagamentos_vencimento(
  p_mes text,
  p_operadores text[] default null,
  p_venc_de date default null,
  p_venc_ate date default null,
  p_incluir_sem_vencimento boolean default true,
  p_limit int default 500,
  p_offset int default 0
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(auth.email());
  v_ini date;
  v_fim date;
  v_lim int := least(greatest(coalesce(p_limit, 500), 1), 500);
  v_off int := greatest(coalesce(p_offset, 0), 0);
  v_ops text[];
  v_total int;
  v_soma_pago numeric;
  v_soma_hon numeric;
  v_qtd_sem_venc int;
  v_itens jsonb;
  v_resumo_op jsonb;
  v_resumo_sit jsonb;
  v_ops_disp jsonb := null;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and v_email not in ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br') then
    raise exception 'Acesso negado: relatorio por vencimento e exclusivo da gestao.'
      using errcode = '42501';
  end if;

  if p_mes is null or p_mes !~ '^\d{4}-\d{2}$' then
    raise exception 'Mes invalido (esperado YYYY-MM).' using errcode = '22023';
  end if;
  v_ini := to_date(p_mes || '-01', 'YYYY-MM-DD');
  v_fim := (v_ini + interval '1 month')::date;

  -- normaliza a selecao de operadores (emails em minusculo; 'SEM_OPERADOR' passa)
  if p_operadores is not null and array_length(p_operadores, 1) > 0 then
    select array_agg(distinct case when upper(trim(o)) = 'SEM_OPERADOR'
                                   then 'SEM_OPERADOR' else lower(trim(o)) end)
      into v_ops
    from unnest(p_operadores) o
    where coalesce(trim(o), '') <> '';
  end if;

  with base as (
    select
      p.id as pagamento_id,
      p.data_pagamento,
      case when (p.dados ->> 'vencimento') ~ '^\d{4}-\d{2}-\d{2}'
           then (p.dados ->> 'vencimento')::date end as vencimento,
      nullif(p.dados ->> 'valor_original', '')::numeric as valor_original,
      p.aluno_nome,
      p.titulo_numero,
      p.numero_parcela_completo,
      coalesce(p.valor_pago, 0) as valor_pago,
      coalesce(p.valor_honorario, 0) as valor_honorario,
      coalesce(nullif(lower(p.operador_email), ''), 'SEM_OPERADOR') as operador_chave,
      coalesce(p.operador_nome,
               case when coalesce(nullif(lower(p.operador_email), ''), '') = ''
                    then 'Sem operador' end) as operador_nome,
      coalesce(p.retroativo, false) as retroativo,
      (coalesce(p.dados, '{}'::jsonb) ? 'estornado_em') as estornado
    from public.pagamentos p
    where p.data_pagamento >= v_ini and p.data_pagamento < v_fim
  ),
  classificado as (
    select b.*,
      case
        when b.vencimento is null then 'SEM_VENCIMENTO'
        when b.data_pagamento < b.vencimento then 'ADIANTADO'
        when b.data_pagamento = b.vencimento then 'EM_DIA'
        else 'ATRASADO'
      end as situacao,
      case when b.vencimento is not null
           then (b.data_pagamento - b.vencimento) end as dias_diferenca
    from base b
  ),
  filtrado as (
    select c.* from classificado c
    where (v_ops is null or c.operador_chave = any(v_ops))
      and (
        (c.vencimento is null and p_incluir_sem_vencimento)
        or (c.vencimento is not null
            and (p_venc_de is null or c.vencimento >= p_venc_de)
            and (p_venc_ate is null or c.vencimento <= p_venc_ate))
      )
  )
  select
    (select count(*) from filtrado),
    (select coalesce(sum(valor_pago), 0) from filtrado),
    (select coalesce(sum(valor_honorario), 0) from filtrado),
    (select count(*) from filtrado where vencimento is null),
    (select coalesce(jsonb_agg(x order by x.soma_honorario desc), '[]'::jsonb)
       from (
         select operador_chave as operador_email,
                case when operador_chave = 'SEM_OPERADOR' then 'Sem operador'
                     else max(operador_nome) end as operador_nome,
                count(*) as qtd,
                sum(valor_pago) as soma_pago, sum(valor_honorario) as soma_honorario,
                count(*) filter (where situacao = 'EM_DIA') as qtd_em_dia,
                count(*) filter (where situacao = 'ADIANTADO') as qtd_adiantado,
                count(*) filter (where situacao = 'ATRASADO') as qtd_atrasado,
                count(*) filter (where situacao = 'SEM_VENCIMENTO') as qtd_sem_vencimento
         from filtrado group by operador_chave
       ) x),
    (select coalesce(jsonb_agg(y order by y.qtd desc), '[]'::jsonb)
       from (
         select situacao, count(*) as qtd,
                sum(valor_pago) as soma_pago, sum(valor_honorario) as soma_honorario
         from filtrado group by situacao
       ) y),
    (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
       from (
         select pagamento_id, data_pagamento, vencimento, situacao, dias_diferenca,
                aluno_nome, titulo_numero, numero_parcela_completo,
                valor_original, valor_pago, valor_honorario,
                operador_chave as operador_email, operador_nome, retroativo, estornado
         from filtrado
         order by operador_chave, vencimento nulls last, data_pagamento, pagamento_id
         limit v_lim offset v_off
       ) i)
  into v_total, v_soma_pago, v_soma_hon, v_qtd_sem_venc, v_resumo_op, v_resumo_sit, v_itens;

  -- lista de operadores do mes (SEM filtro) para montar o seletor da tela;
  -- so na primeira pagina para nao repetir trabalho.
  if v_off = 0 then
    select coalesce(jsonb_agg(z order by z.qtd desc), '[]'::jsonb)
      into v_ops_disp
    from (
      select coalesce(nullif(lower(p.operador_email), ''), 'SEM_OPERADOR') as operador_email,
             case when coalesce(nullif(lower(p.operador_email), ''), 'SEM_OPERADOR') = 'SEM_OPERADOR'
                  then 'Sem operador' else max(p.operador_nome) end as operador_nome,
             count(*) as qtd
      from public.pagamentos p
      where p.data_pagamento >= v_ini and p.data_pagamento < v_fim
      group by 1
    ) z;
  end if;

  return jsonb_build_object(
    'mes_referencia', p_mes,
    'total', v_total,
    'soma_pago', v_soma_pago,
    'soma_honorario', v_soma_hon,
    'qtd_sem_vencimento', v_qtd_sem_venc,
    'limit', v_lim,
    'offset', v_off,
    'resumo_por_operador', v_resumo_op,
    'resumo_por_situacao', v_resumo_sit,
    'operadores_disponiveis', v_ops_disp,
    'itens', v_itens);
end;
$function$;

revoke all on function public.projecao_relatorio_pagamentos_vencimento(text, text[], date, date, boolean, int, int) from public, anon;
grant execute on function public.projecao_relatorio_pagamentos_vencimento(text, text[], date, date, boolean, int, int) to authenticated, service_role;

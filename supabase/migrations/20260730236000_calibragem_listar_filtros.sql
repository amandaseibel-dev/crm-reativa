-- ============================================================================
-- CALIBRAGEM — FILTROS CLICÁVEIS COMBINÁVEIS no drill-down (item 9)
-- ----------------------------------------------------------------------------
-- Estende calibragem_listar_casos com p_filtros jsonb combináveis:
--   {valor_min, valor_max, criticidade, sem_acionamento_dias, unidade, curso, origem}
-- Mantém p_faixa (atraso) e p_ano. Reversível (recria a versão anterior de 5 args).
-- ============================================================================

begin;

-- remove a versão de 5 argumentos (será substituída pela de 6)
drop function if exists public.calibragem_listar_casos(text,text,text,integer,integer);

create or replace function public.calibragem_listar_casos(
  p_operador_email text,
  p_indicador text,
  p_faixa text default null,
  p_ano   integer default null,
  p_limit integer default 300,
  p_filtros jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_rows jsonb; v_fa_min int; v_fa_max int;
  v_valor_min numeric := nullif(p_filtros->>'valor_min','')::numeric;
  v_valor_max numeric := nullif(p_filtros->>'valor_max','')::numeric;
  v_crit text := upper(nullif(p_filtros->>'criticidade',''));
  v_sem_ac int := nullif(p_filtros->>'sem_acionamento_dias','')::int;
  v_unidade text := nullif(p_filtros->>'unidade','');
  v_curso text := nullif(p_filtros->>'curso','');
  v_origem text := nullif(p_filtros->>'origem','');
begin
  if not public.calibragem_e_gestao() then raise exception 'Sem permissão para detalhar a Calibragem.'; end if;
  if p_faixa is not null then
    v_fa_min := split_part(replace(p_faixa,'+',''), '-', 1)::int;
    v_fa_max := case when p_faixa like '%+' then 100000 else nullif(split_part(p_faixa,'-',2),'')::int end;
  end if;

  select coalesce(jsonb_agg(t order by (t->>'saldo')::numeric desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
             'caso_id', c.id, 'aluno_id', c.aluno_id, 'cpf', coalesce(c.cpf_limpo, c.cpf),
             'nome', coalesce(c.nome, c.nome_aluno), 'saldo', round(coalesce(s.saldo_total,0),2),
             'dias_atraso', coalesce(c.dias_atraso,0), 'criticidade', coalesce(c.criticidade,'-'),
             'status_acionamento', coalesce(c.status_acionamento,'—'), 'ultimo_acionamento', c.data_ultimo_acionamento,
             'unidade', c.unidade, 'curso', c.curso, 'ano_divida', extract(year from s.venc_min)
           ) as t
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where c.operador_email = p_operador_email
      and (
        p_indicador = 'cpfs' or p_indicador = 'saldo_total'
        or (p_indicador = 'mensalidades'             and coalesce(s.saldo_mensalidade,0) > 0)
        or (p_indicador = 'titulos_abertos'          and coalesce(s.qtd_titulos_abertos,0) > 0)
        or (p_indicador = 'sem_acionamento'          and c.status_acionamento is null)
        or (p_indicador = 'sem_acionamento_recente'  and c.status_acionamento is not null and c.data_ultimo_acionamento < current_date - 10)
        or (p_indicador = 'criticos'                 and upper(coalesce(c.criticidade,'')) in ('CRITICO','URGENTE'))
        or (p_indicador = 'antigos'                  and coalesce(c.dias_atraso,0) > 360)
        or (p_indicador = 'faixa_atraso') or (p_indicador = 'ano')
      )
      -- filtros combináveis (item 9)
      and (p_faixa is null or (coalesce(c.dias_atraso,0) between v_fa_min and v_fa_max))
      and (p_ano   is null or (extract(year from s.venc_min) = p_ano))
      and (v_valor_min is null or coalesce(s.saldo_total,0) >= v_valor_min)
      and (v_valor_max is null or coalesce(s.saldo_total,0) <  v_valor_max)
      and (v_crit is null or upper(coalesce(c.criticidade,'')) = v_crit)
      and (v_sem_ac is null or (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento < current_date - v_sem_ac))
      and (v_unidade is null or c.unidade ilike '%'||v_unidade||'%')
      and (v_curso is null or c.curso ilike '%'||v_curso||'%')
      and (v_origem is null or coalesce(c.origem,'') ilike '%'||v_origem||'%')
    limit p_limit
  ) q;

  return jsonb_build_object('operador_email', p_operador_email, 'indicador', p_indicador,
    'faixa', p_faixa, 'ano', p_ano, 'filtros', p_filtros,
    'total', jsonb_array_length(v_rows), 'casos', v_rows);
end;
$$;

revoke all on function public.calibragem_listar_casos(text,text,text,integer,integer,jsonb) from public;
grant execute on function public.calibragem_listar_casos(text,text,text,integer,integer,jsonb) to authenticated;

commit;

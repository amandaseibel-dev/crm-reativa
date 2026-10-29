-- ============================================================================
-- CALIBRAGEM — DRILL-DOWN: listar casos exatos de um indicador (itens 2.1 / 9)
-- ----------------------------------------------------------------------------
-- Ao clicar num card/indicador de um operador, retorna a LISTA EXATA de casos
-- que compõem aquele número. Consulta AO VIVO, filtrada por 1 operador
-- (barato). Filtros combináveis: faixa de atraso e ano da dívida.
--
-- Indicadores baseados em `casos` (carteira): cpfs, mensalidades, saldo_total,
-- sem_acionamento, sem_acionamento_recente, criticos, antigos, faixa_atraso, ano.
-- Reversível (drop function).
-- ============================================================================

begin;

create or replace function public.calibragem_listar_casos(
  p_operador_email text,
  p_indicador text,
  p_faixa text default null,     -- rótulo de faixa de atraso (ex: '31-60')
  p_ano   integer default null,  -- ano da dívida (ex: 2026)
  p_limit integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_fa_min int; v_fa_max int;
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissão para detalhar a Calibragem.';
  end if;

  -- decodifica faixa de atraso -> min/max
  if p_faixa is not null then
    v_fa_min := split_part(replace(p_faixa,'+',''), '-', 1)::int;
    v_fa_max := case when p_faixa like '%+' then 100000
                     else nullif(split_part(p_faixa,'-',2),'')::int end;
  end if;

  select coalesce(jsonb_agg(t order by (t->>'saldo')::numeric desc), '[]'::jsonb)
  into v_rows
  from (
    select jsonb_build_object(
             'caso_id', c.id,
             'aluno_id', c.aluno_id,
             'cpf', coalesce(c.cpf_limpo, c.cpf),
             'nome', coalesce(c.nome, c.nome_aluno),
             'saldo', round(coalesce(s.saldo_total,0),2),
             'dias_atraso', coalesce(c.dias_atraso,0),
             'criticidade', coalesce(c.criticidade,'-'),
             'status_acionamento', coalesce(c.status_acionamento,'—'),
             'ultimo_acionamento', c.data_ultimo_acionamento,
             'ano_divida', extract(year from s.venc_min)
           ) as t
    from public.casos c
    left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    where c.operador_email = p_operador_email
      and (
        p_indicador = 'cpfs'
        or p_indicador = 'saldo_total'
        or (p_indicador = 'mensalidades'             and coalesce(s.saldo_mensalidade,0) > 0)
        or (p_indicador = 'titulos_abertos'          and coalesce(s.qtd_titulos_abertos,0) > 0)
        or (p_indicador = 'sem_acionamento'          and c.status_acionamento is null)
        or (p_indicador = 'sem_acionamento_recente'  and c.status_acionamento is not null and c.data_ultimo_acionamento < current_date - 10)
        or (p_indicador = 'criticos'                 and upper(coalesce(c.criticidade,'')) in ('CRITICO','URGENTE'))
        or (p_indicador = 'antigos'                  and coalesce(c.dias_atraso,0) > 360)
        or (p_indicador = 'faixa_atraso')
        or (p_indicador = 'ano')
      )
      and (p_faixa is null or (coalesce(c.dias_atraso,0) between v_fa_min and v_fa_max))
      and (p_ano   is null or (extract(year from s.venc_min) = p_ano))
    limit p_limit
  ) q;

  return jsonb_build_object(
    'operador_email', p_operador_email,
    'indicador', p_indicador,
    'faixa', p_faixa,
    'ano', p_ano,
    'total', jsonb_array_length(v_rows),
    'casos', v_rows
  );
end;
$$;

revoke all on function public.calibragem_listar_casos(text,text,text,integer,integer) from public;
grant execute on function public.calibragem_listar_casos(text,text,text,integer,integer) to authenticated;

commit;

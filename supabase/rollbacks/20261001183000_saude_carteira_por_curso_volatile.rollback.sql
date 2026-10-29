-- Rollback de supabase/migrations/20261001183000_saude_carteira_por_curso_volatile.sql.
--
-- ATENCAO: voltar para STABLE devolve o DEFEITO. A funcao passa a falhar de
-- novo com "DROP TABLE is not allowed in a non-volatile function", e o painel
-- "Por curso" volta a nao abrir. Este arquivo existe por simetria do processo,
-- nao porque reverter seja seguro.
--
-- Corpo identico ao da migration: md5 3808bbe6d797dcd5494b3e708ede4269.

create or replace function public.saude_carteira_por_curso(p_filtros jsonb default '{}'::jsonb)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_incluir_encerrados boolean := coalesce((v_f->>'incluir_encerrados')::boolean, false);
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_curso jsonb;
  v_total numeric;
begin
  perform public.exigir_capacidade('saude da carteira (curso)');

  drop table if exists tmp_sc_curso;
  create temporary table tmp_sc_curso on commit drop as
  select v.aluno_id, v.saldo_total,
         lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') as cpf
    from public.mv_saude_carteira v
    join public.alunos a on a.id = v.aluno_id
   where (v_incluir_encerrados or v.encerrado = false)
     and (v_estab is null or v.estabelecimento = v_estab)
     and (v_operador is null or v.operador_email is not distinct from v_operador);

  select coalesce(sum(saldo_total),0) into v_total from tmp_sc_curso;

  -- Os 12 maiores por saldo; o resto vira "Outros cursos", para a tela nao
  -- virar uma lista de 130 linhas. O ticket medio vai junto: e ele que mostra
  -- que Medicina e outro negocio, nao so um curso maior.
  with curso as (
    select lpad(regexp_replace(coalesce(cpf,''), '\D', '', 'g'), 11, '0') as cpf,
           (array_agg(curso order by valid_from desc nulls last))[1] as curso
      from public.prime_contratos
     where curso is not null
     group by 1
  ), agrupado as (
    select coalesce(c.curso, 'Sem curso no Prime') as curso,
           count(*) as casos,
           round(coalesce(sum(b.saldo_total),0), 2) as saldo
      from tmp_sc_curso b
      left join curso c on c.cpf = b.cpf
     group by 1
  ), ranqueado as (
    select *, row_number() over (order by saldo desc) as posicao from agrupado
  )
  select jsonb_agg(x order by (x->>'saldo')::numeric desc)
    into v_curso
    from (
      select jsonb_build_object(
               'curso', curso, 'casos', casos, 'saldo', saldo,
               'ticket_medio', round(saldo / greatest(casos,1), 2),
               'pct_valor', round(100.0 * saldo / nullif(v_total,0), 1)
             ) as x
        from ranqueado where posicao <= 12
      union all
      select jsonb_build_object(
               'curso', 'Outros cursos', 'casos', sum(casos), 'saldo', sum(saldo),
               'ticket_medio', round(sum(saldo) / greatest(sum(casos),1), 2),
               'pct_valor', round(100.0 * sum(saldo) / nullif(v_total,0), 1)
             )
        from ranqueado where posicao > 12
       having count(*) > 0
    ) y;

  return jsonb_build_object(
    'por_curso', coalesce(v_curso, '[]'::jsonb),
    'total', round(v_total, 2),
    'calculado_em', now()
  );
end;
$function$;

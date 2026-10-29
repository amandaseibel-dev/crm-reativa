-- "POR CURSO" VOLTA A ABRIR.
--
-- A tela Saude Completa da Carteira mostra, no lugar do painel por curso:
--
--   "Nao foi possivel carregar a carteira por curso:
--    DROP TABLE is not allowed in a non-volatile function"
--
-- CAUSA: `saude_carteira_por_curso` foi criada STABLE (migration
-- 20260909093237, registrada como aplicada em producao) e a primeira coisa que
-- o corpo faz e:
--
--   drop table if exists tmp_sc_curso;
--   create temporary table tmp_sc_curso on commit drop as ...
--
-- O PostgreSQL executa o corpo de uma funcao nao-VOLATILE em modo somente
-- leitura (SPI read-only) e recusa qualquer comando que escreva. A funcao
-- NUNCA funcionou: esta quebrada desde 09/09/2026, 22 dias.
--
-- Nao adianta so remover o `drop table`: o `create temporary table` cai na
-- mesma restricao. E VOLATILE e a classificacao correta para uma funcao que
-- cria tabela temporaria -- STABLE era a declaracao errada desde o inicio.
--
-- CORRECAO MINIMA: so a volatilidade. O corpo vai aqui byte a byte igual ao de
-- producao (md5 3808bbe6d797dcd5494b3e708ede4269, 2708 bytes). Nenhuma mudanca
-- de logica, de filtro, de agrupamento, de arredondamento ou de retorno -- o
-- `create or replace` exige o corpo inteiro, entao ele aparece por completo,
-- mas nao foi tocado.
--
-- SEGURANCA: `security definer`, `search_path` e o portao interno
-- (`exigir_capacidade`) seguem exatamente como estavam. VOLATILE nao afrouxa
-- permissao nenhuma -- so permite que o corpo escreva na sua propria tabela
-- temporaria, que ja era a intencao do codigo.
--
-- CUSTO: VOLATILE impede que o planejador cacheie/reordene a chamada. Como a
-- funcao e chamada uma vez por carregamento de tela e ja fazia DDL, nao ha
-- plano a perder: hoje ela nao chega a executar.
--
-- Rollback: supabase/rollbacks/20261001183000_saude_carteira_por_curso_volatile.rollback.sql
--           (devolve STABLE, ou seja, devolve o defeito -- existe por simetria)

create or replace function public.saude_carteira_por_curso(p_filtros jsonb default '{}'::jsonb)
 returns jsonb
 language plpgsql
 volatile security definer
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

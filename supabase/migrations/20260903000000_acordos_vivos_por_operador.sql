-- Acordos vivos por operador: a vencer, vencido e a renegociar.
--
-- POR QUE ESTA TELA EXISTE. O sistema mede esforço (Efetividade) e estoque
-- (Saúde da Carteira), mas nada acompanha o acordo DEPOIS de fechado -- e é lá
-- que estão R$ 11,9 mi. Medido em 02/09/2026: dos 2.447 acordos ATIVOS, só 683
-- (27,9%) não têm nenhuma parcela vencida; 618 já têm três ou mais, com atraso
-- médio de 244 dias. Nenhuma tela mostrava isso.
--
-- VOCABULÁRIO (decisão da gestão, 02/09/2026): acordo NÃO quebra -- acordo se
-- renegocia. O estado terminal aqui se chama A_RENEGOCIAR, e o corte de 3+
-- parcelas vencidas é gatilho de entrada na fila, não sentença.
--
-- COMO O DONO É RESOLVIDO. Pelo E-MAIL, nunca pelo nome. `operadores.js` e a
-- tabela `usuarios` discordam no rótulo (NATALI x Nataly, MAURÍCIO x Mauricio,
-- AMANDA ADM x Amanda Borges) e `acordos.operador_responsavel_nome` é campo
-- livre preenchido em só 156 dos 2.447 acordos, com a caixa que a planilha do
-- Prime mandou. A ordem é: responsável do ALUNO -> responsável do ACORDO ->
-- "sem responsável". O nome exibido sai sempre de `usuarios`, para a mesma
-- pessoa nunca aparecer em duas linhas.
--
-- ORDEM DELIBERADA: esta é uma tela de LEITURA e não corrige nada. As correções
-- de dono (362 acordos com dono divergente do aluno, 530 sem dono nenhum) ficam
-- para a próxima remessa, junto com a redistribuição -- decisão de 03/09/2026.
-- Até lá a linha "sem responsável" fica visível de propósito: ela é o checklist
-- da remessa.
--
-- ACESSO: gestão apenas (Amanda gestora, Fernanda, Amanda ADM), pelo mesmo
-- guard da Calibragem.

-- ---------------------------------------------------------------------------
-- 1) Resumo por operador
-- ---------------------------------------------------------------------------
create or replace function public.carteira_acordos_por_operador()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_linhas jsonb;
  v_totais jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para ver os acordos por operador.';
  end if;

  with acordo as (
    select
      a.id,
      coalesce(a.saldo, 0) as saldo,
      -- Dono: aluno primeiro, acordo como reserva. Sempre e-mail, nunca nome.
      lower(nullif(coalesce(al.responsavel_atual_email, a.operador_responsavel_email), '')) as dono_email,
      count(p.*) filter (where p.status = 'VENCIDA') as vencidas,
      coalesce(sum(p.valor) filter (where p.status = 'VENCIDA'), 0) as valor_vencido,
      count(p.*) filter (
        where p.status = 'A_VENCER' and p.vencimento between current_date and current_date + 6
      ) as parcelas_7d,
      coalesce(sum(p.valor) filter (
        where p.status = 'A_VENCER' and p.vencimento between current_date and current_date + 6
      ), 0) as valor_7d,
      count(p.*) filter (
        where p.status = 'A_VENCER' and p.vencimento between current_date and current_date + 29
      ) as parcelas_30d,
      coalesce(sum(p.valor) filter (
        where p.status = 'A_VENCER' and p.vencimento between current_date and current_date + 29
      ), 0) as valor_30d,
      max(case when p.status = 'VENCIDA' then current_date - p.vencimento end) as dias_atraso
    from public.acordos a
    left join public.alunos al on al.id = a.aluno_id
    left join public.parcelas p on p.acordo_id = a.id
    where upper(coalesce(a.status, '')) = 'ATIVO'
    group by a.id, a.saldo, al.responsavel_atual_email, a.operador_responsavel_email
  )
  select
    coalesce(jsonb_agg(linha order by linha_saldo desc), '[]'::jsonb),
    jsonb_build_object(
      'acordos', sum(qtd_acordos),
      'saldo', round(sum(linha_saldo)::numeric, 2),
      'em_dia', sum(qtd_em_dia),
      'atrasados', sum(qtd_atrasados),
      'a_renegociar', sum(qtd_renegociar),
      'vencido_renegociar', round(sum(v_renegociar)::numeric, 2),
      'vencido_total', round(sum(v_vencido)::numeric, 2),
      'parcelas_7d', sum(p7),
      'valor_7d', round(sum(v7)::numeric, 2),
      'parcelas_30d', sum(p30),
      'valor_30d', round(sum(v30)::numeric, 2)
    )
  into v_linhas, v_totais
  from (
    select
      jsonb_build_object(
        'operador_email', ac.dono_email,
        -- O rótulo vem de `usuarios`. Sem cadastro, mostra o próprio e-mail --
        -- melhor um e-mail feio do que dois nomes para a mesma pessoa.
        'operador_nome', coalesce(u.nome, ac.dono_email, 'Sem responsável'),
        'sem_dono', (ac.dono_email is null),
        'acordos', count(*),
        'saldo', round(sum(ac.saldo)::numeric, 2),
        'em_dia', count(*) filter (where ac.vencidas = 0),
        'atrasados', count(*) filter (where ac.vencidas between 1 and 2),
        'a_renegociar', count(*) filter (where ac.vencidas >= 3),
        'vencido_renegociar', round(coalesce(sum(ac.valor_vencido) filter (where ac.vencidas >= 3), 0)::numeric, 2),
        'vencido_total', round(sum(ac.valor_vencido)::numeric, 2),
        'parcelas_7d', sum(ac.parcelas_7d),
        'valor_7d', round(sum(ac.valor_7d)::numeric, 2),
        'parcelas_30d', sum(ac.parcelas_30d),
        'valor_30d', round(sum(ac.valor_30d)::numeric, 2),
        'dias_atraso_medio', round(avg(ac.dias_atraso) filter (where ac.vencidas >= 3))
      ) as linha,
      sum(ac.saldo) as linha_saldo,
      count(*) as qtd_acordos,
      count(*) filter (where ac.vencidas = 0) as qtd_em_dia,
      count(*) filter (where ac.vencidas between 1 and 2) as qtd_atrasados,
      count(*) filter (where ac.vencidas >= 3) as qtd_renegociar,
      coalesce(sum(ac.valor_vencido) filter (where ac.vencidas >= 3), 0) as v_renegociar,
      sum(ac.valor_vencido) as v_vencido,
      sum(ac.parcelas_7d) as p7, sum(ac.valor_7d) as v7,
      sum(ac.parcelas_30d) as p30, sum(ac.valor_30d) as v30
    from acordo ac
    left join public.usuarios u on lower(u.email) = ac.dono_email
    group by ac.dono_email, u.nome
  ) agrupado;

  return jsonb_build_object(
    'gerado_em', now(),
    'linhas', v_linhas,
    'totais', coalesce(v_totais, '{}'::jsonb)
  );
end;
$function$;

revoke all on function public.carteira_acordos_por_operador() from public;
grant execute on function public.carteira_acordos_por_operador() to authenticated;

comment on function public.carteira_acordos_por_operador() is
  'Acordos ATIVOS por operador: em dia, atrasado (1-2 vencidas), a renegociar (3+), '
  'e o que vence em 7 e 30 dias. Dono resolvido por e-mail (aluno -> acordo), rótulo de usuarios. Gestão apenas.';

-- ---------------------------------------------------------------------------
-- 2) Detalhe: a lista de alunos por trás de cada número
-- ---------------------------------------------------------------------------
-- Sem esta parte a tela é relatório; com ela vira fila de trabalho. O CPF sai
-- MASCARADO -- a tela é de acompanhamento, não precisa do documento inteiro.
create or replace function public.carteira_acordos_detalhe(
  p_operador_email text default null,
  p_estado text default 'TODOS',
  p_limite int default 200,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_estado text := upper(coalesce(nullif(p_estado, ''), 'TODOS'));
  v_email text := lower(nullif(trim(coalesce(p_operador_email, '')), ''));
  v_limite int := least(greatest(coalesce(p_limite, 200), 1), 500);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int;
  v_itens jsonb;
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para ver o detalhe dos acordos.';
  end if;

  if v_estado not in ('TODOS', 'EM_DIA', 'ATRASADO', 'RENEGOCIAR', 'VENCE_7', 'VENCE_30') then
    raise exception 'Estado inválido: %. Use TODOS, EM_DIA, ATRASADO, RENEGOCIAR, VENCE_7 ou VENCE_30.', p_estado;
  end if;

  with acordo as (
    select
      a.id, a.numero_acordo, a.aluno_id, coalesce(a.saldo, 0) as saldo,
      lower(nullif(coalesce(al.responsavel_atual_email, a.operador_responsavel_email), '')) as dono_email,
      al.nome, al.cpf_mascarado, al.telefone,
      count(p.*) filter (where p.status = 'VENCIDA') as vencidas,
      coalesce(sum(p.valor) filter (where p.status = 'VENCIDA'), 0) as valor_vencido,
      max(case when p.status = 'VENCIDA' then current_date - p.vencimento end) as dias_atraso,
      min(case when p.status = 'A_VENCER' then p.vencimento end) as proximo_vencimento,
      count(p.*) filter (
        where p.status = 'A_VENCER' and p.vencimento between current_date and current_date + 6
      ) as parcelas_7d,
      count(p.*) filter (
        where p.status = 'A_VENCER' and p.vencimento between current_date and current_date + 29
      ) as parcelas_30d
    from public.acordos a
    left join public.alunos al on al.id = a.aluno_id
    left join public.parcelas p on p.acordo_id = a.id
    where upper(coalesce(a.status, '')) = 'ATIVO'
    group by a.id, a.numero_acordo, a.aluno_id, a.saldo,
             al.responsavel_atual_email, a.operador_responsavel_email,
             al.nome, al.cpf_mascarado, al.telefone
  ),
  filtrado as (
    select ac.*,
      -- Último acionamento vem do caso, que é onde a fidelização olha.
      (select max(c.data_ultimo_acionamento) from public.casos c
        where c.aluno_id = ac.aluno_id and coalesce(c.encerrado_operacional, false) = false) as ultimo_acionamento
    from acordo ac
    where (
        v_email is null
        or (v_email = 'sem-responsavel' and ac.dono_email is null)
        or (v_email <> 'sem-responsavel' and ac.dono_email = v_email)
      )
      and case v_estado
            when 'EM_DIA' then ac.vencidas = 0
            when 'ATRASADO' then ac.vencidas between 1 and 2
            when 'RENEGOCIAR' then ac.vencidas >= 3
            when 'VENCE_7' then ac.parcelas_7d > 0
            when 'VENCE_30' then ac.parcelas_30d > 0
            else true
          end
  )
  select count(*)::int,
    coalesce(
      jsonb_agg(item order by ordem_vencido desc, ordem_id) filter (where rn > v_offset and rn <= v_offset + v_limite),
      '[]'::jsonb
    )
  into v_total, v_itens
  from (
    select
      jsonb_build_object(
        'acordo_id', f.id,
        'numero_acordo', f.numero_acordo,
        'aluno_id', f.aluno_id,
        'nome', f.nome,
        'cpf', f.cpf_mascarado,
        'telefone', f.telefone,
        'saldo', round(f.saldo::numeric, 2),
        'vencidas', f.vencidas,
        'valor_vencido', round(f.valor_vencido::numeric, 2),
        'dias_atraso', f.dias_atraso,
        'proximo_vencimento', f.proximo_vencimento,
        'ultimo_acionamento', f.ultimo_acionamento,
        'estado', case when f.vencidas = 0 then 'EM_DIA'
                       when f.vencidas <= 2 then 'ATRASADO'
                       else 'RENEGOCIAR' end
      ) as item,
      f.valor_vencido as ordem_vencido,
      f.id as ordem_id,
      -- `id` como último critério de desempate: sem ele a paginação repete e
      -- perde linha quando há empate de valor (já aconteceu na fila).
      row_number() over (order by f.valor_vencido desc, f.id) as rn
    from filtrado f
  ) pagina;

  return jsonb_build_object(
    'total', coalesce(v_total, 0),
    'limite', v_limite,
    'offset', v_offset,
    'itens', coalesce(v_itens, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.carteira_acordos_detalhe(text, text, int, int) from public;
grant execute on function public.carteira_acordos_detalhe(text, text, int, int) to authenticated;

comment on function public.carteira_acordos_detalhe(text, text, int, int) is
  'Lista os acordos ATIVOS por trás de um número da tela: filtra por operador (ou "sem-responsavel") '
  'e por estado (TODOS/EM_DIA/ATRASADO/RENEGOCIAR/VENCE_7/VENCE_30). CPF mascarado. Gestão apenas.';

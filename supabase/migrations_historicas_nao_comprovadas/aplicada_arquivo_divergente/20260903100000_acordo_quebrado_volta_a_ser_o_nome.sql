-- O estado volta a se chamar QUEBRADO.
--
-- Em 02/09 a gestão pediu para não usar "quebrado" -- "acordo não quebra, é
-- renegociado" -- e a tela nasceu com "a renegociar". Em 03/09 a gestão pediu o
-- contrário: o rótulo volta a ser QUEBRADO. É decisão de vocabulário, não de
-- regra, e quem fala com o aluno é quem escolhe a palavra.
--
-- O QUE **NÃO** MUDOU, e continua valendo: quando o acordo volta para a fila,
-- volta com o SALDO DO ACORDO -- não com a dívida original. A mensalidade que
-- ele substituiu não ressuscita. Essa parte da decisão de 02/09 está de pé.
--
-- COMPATIBILIDADE: 'RENEGOCIAR' segue aceito como sinônimo de 'QUEBRADO'. A
-- função é nova (03/09) e só a tela /acordos-operador chama, mas um link salvo
-- ou uma aba aberta com o valor antigo não deve quebrar na cara de ninguém.
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

  -- Sinônimo do nome antigo, para link salvo não morrer.
  if v_estado = 'RENEGOCIAR' then v_estado := 'QUEBRADO'; end if;

  if v_estado not in ('TODOS', 'EM_DIA', 'ATRASADO', 'QUEBRADO', 'VENCE_7', 'VENCE_30') then
    raise exception 'Estado inválido: %. Use TODOS, EM_DIA, ATRASADO, QUEBRADO, VENCE_7 ou VENCE_30.', p_estado;
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
            when 'QUEBRADO' then ac.vencidas >= 3
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
                       else 'QUEBRADO' end
      ) as item,
      f.valor_vencido as ordem_vencido,
      f.id as ordem_id,
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

comment on function public.carteira_acordos_detalhe(text, text, int, int) is
  'Lista os acordos ATIVOS por trás de um número da tela: filtra por operador (ou "sem-responsavel") '
  'e por estado (TODOS/EM_DIA/ATRASADO/QUEBRADO/VENCE_7/VENCE_30; RENEGOCIAR aceito como sinônimo de QUEBRADO). '
  'CPF mascarado. Gestão apenas.';

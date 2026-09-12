-- DONO DO ACORDO = acordos.operador_responsavel_email. Ponto.
--
-- Bug operacional relatado pela gestao em 12/09/2026: operadora abria os
-- "Acordos por operador" e via acordo que nao e dela; e o acordo que e dela,
-- de aluno cuja ficha esta com outra pessoa, nao aparecia em lugar nenhum.
--
-- Causa: tres RPCs decidiam a propriedade do ACORDO com
--
--   coalesce(al.responsavel_atual_email, a.operador_responsavel_email)
--
-- isto e, o responsavel da FICHA do aluno tinha precedencia sobre o
-- responsavel do proprio acordo. Sao duas coisas diferentes e nenhuma herda da
-- outra:
--
--   * alunos.responsavel_atual_email  -> quem cobra a FICHA/MENSALIDADE
--   * acordos.operador_responsavel_email -> quem acompanha o ACORDO
--
-- Medicao em producao antes da mudanca (2.514 acordos ATIVO):
--
--   1.199  acordos  R$ 7.391.073,11  ficha e acordo no mesmo nome (nao muda)
--     573  acordos  R$ 3.769.476,89  apareciam para o responsavel da FICHA e
--                                    passam a aparecer para o responsavel do
--                                    ACORDO (nao "desaparecem": trocam de dono)
--     742  acordos  R$   622.814,04  apareciam para o responsavel da FICHA e
--                                    nao tem responsavel de acordo nenhum
--   ------
--   1.315  acordos  R$ 4.392.290,93  mal exibidos hoje
--
--   Com os 10 que ja estavam sem dono pelos dois criterios, o grupo
--   "Sem responsavel" fecha em 752 acordos / R$ 625.347,61.
--
-- Acordo com operador_responsavel_email IS NULL e SEM RESPONSAVEL: nao entra na
-- conta de operadora nenhuma, nao ganha responsavel por inferencia, e segue
-- visivel para a gestao na linha "Sem responsavel" (chave 'sem-responsavel' no
-- detalhe). Nada de dado e alterado por esta migration -- ela so muda como as
-- RPCs LEEM o que ja esta gravado.
--
-- Nao toca em nada do fluxo Santander/pagamentos.

-- ---------------------------------------------------------------------------
-- 1) Resumo por operador (tela Acordos por operador, so gestao)
-- ---------------------------------------------------------------------------
create or replace function public.carteira_acordos_por_operador()
returns jsonb
language plpgsql stable security definer set search_path = public
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
      -- FONTE DE VERDADE do dono do ACORDO. Nao usar o responsavel da ficha.
      lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) as dono_email,
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
    left join public.parcelas p on p.acordo_id = a.id
    where upper(coalesce(a.status, '')) = 'ATIVO'
    group by a.id, a.saldo, a.operador_responsavel_email
  )
  select
    coalesce(jsonb_agg(linha order by linha_saldo desc), '[]'::jsonb),
    jsonb_build_object(
      'acordos', sum(qtd_acordos),
      'saldo', round(sum(linha_saldo)::numeric, 2),
      'em_dia', sum(qtd_em_dia),
      'atrasados', sum(qtd_atrasados),
      'a_renegociar', sum(qtd_renegociar),
      'quebrados', sum(qtd_renegociar),
      'vencido_renegociar', round(sum(v_renegociar)::numeric, 2),
      'vencido_quebrado', round(sum(v_renegociar)::numeric, 2),
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
        'operador_nome', coalesce(u.nome, ac.dono_email, 'Sem responsável'),
        'sem_dono', (ac.dono_email is null),
        'acordos', count(*),
        'saldo', round(sum(ac.saldo)::numeric, 2),
        'em_dia', count(*) filter (where ac.vencidas = 0),
        'atrasados', count(*) filter (where ac.vencidas between 1 and 2),
        -- O estado de 3+ parcelas vencidas tem UM nome tecnico: QUEBRADO. A
        -- chave `a_renegociar` fica como apelido para nao quebrar quem ja lia
        -- ela; `quebrados` e a chave que o front passa a usar, a mesma palavra
        -- que carteira_acordos_detalhe exige em p_estado.
        'a_renegociar', count(*) filter (where ac.vencidas >= 3),
        'quebrados', count(*) filter (where ac.vencidas >= 3),
        'vencido_renegociar', round(coalesce(sum(ac.valor_vencido) filter (where ac.vencidas >= 3), 0)::numeric, 2),
        'vencido_quebrado', round(coalesce(sum(ac.valor_vencido) filter (where ac.vencidas >= 3), 0)::numeric, 2),
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

revoke all on function public.carteira_acordos_por_operador() from public, anon;
grant execute on function public.carteira_acordos_por_operador() to authenticated;

comment on function public.carteira_acordos_por_operador() is
  'Acordos ATIVO agrupados pelo DONO DO ACORDO (acordos.operador_responsavel_email). Nao usa o responsavel da ficha do aluno. Sem responsavel -> linha "Sem responsavel", visivel so para a gestao.';

-- ---------------------------------------------------------------------------
-- 2) Detalhe (gaveta) de um operador / do grupo sem responsavel
-- ---------------------------------------------------------------------------
create or replace function public.carteira_acordos_detalhe(
  p_operador_email text default null,
  p_estado text default 'TODOS',
  p_limite integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public
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

  -- 'RENEGOCIAR' era o nome antigo do mesmo estado. Continua aceito para nao
  -- quebrar chamador velho, mas o nome tecnico e QUEBRADO.
  if v_estado = 'RENEGOCIAR' then v_estado := 'QUEBRADO'; end if;

  if v_estado not in ('TODOS', 'EM_DIA', 'ATRASADO', 'QUEBRADO', 'VENCE_7', 'VENCE_30') then
    raise exception 'Estado inválido: %. Use TODOS, EM_DIA, ATRASADO, QUEBRADO, VENCE_7 ou VENCE_30.', p_estado;
  end if;

  with acordo as (
    select
      a.id, a.numero_acordo, a.aluno_id, coalesce(a.saldo, 0) as saldo,
      -- FONTE DE VERDADE do dono do ACORDO. O join com alunos fica so para
      -- nome/CPF/telefone da linha -- nunca para decidir de quem e o acordo.
      lower(nullif(trim(coalesce(a.operador_responsavel_email, '')), '')) as dono_email,
      al.nome, al.cpf_mascarado, al.telefone,
      al.responsavel_atual_email as ficha_responsavel_email,
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
             a.operador_responsavel_email,
             al.nome, al.cpf_mascarado, al.telefone, al.responsavel_atual_email
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
        -- Quem cobra a FICHA desse aluno. Informativo: deixa explicito na tela
        -- quando acordo e mensalidade estao com pessoas diferentes, em vez de a
        -- operadora ter que adivinhar.
        'ficha_responsavel_email', f.ficha_responsavel_email,
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

revoke all on function public.carteira_acordos_detalhe(text, text, integer, integer) from public, anon;
grant execute on function public.carteira_acordos_detalhe(text, text, integer, integer) to authenticated;

comment on function public.carteira_acordos_detalhe(text, text, integer, integer) is
  'Detalhe dos acordos ATIVO de um DONO DE ACORDO (acordos.operador_responsavel_email); p_operador_email = ''sem-responsavel'' traz os sem responsavel. p_estado aceita QUEBRADO (nome tecnico) e RENEGOCIAR (apelido antigo).';

-- ---------------------------------------------------------------------------
-- 3) "Quantos CPFs eu tenho de mensalidade e quantos de acordo?"
-- ---------------------------------------------------------------------------
-- Aqui as duas pernas ficam EXPLICITAMENTE separadas:
--
--   ficha  -> meus CASOS (casos.operador_email). Manda na mensalidade.
--   acordo -> meus ACORDOS (acordos.operador_responsavel_email). Manda no
--             acordo, mesmo que a ficha do aluno seja de outra pessoa.
--
-- Antes as duas vinham da mesma perna: o numero de "CPFs com acordo" era
-- "alunos da MINHA ficha que por acaso tem acordo", de quem quer que fosse o
-- acordo. Quem tinha o acordo e nao a ficha nao via o acordo em lugar nenhum.
create or replace function public.minha_carteira_resumo(p_operador_email text default null)
returns table (
  operador_email text, operador_nome text,
  cpfs_so_mensalidade int, cpfs_com_acordo int,
  cpfs_acordo_e_mensalidade int, cpfs_total int,
  valor_mensalidade numeric, valor_acordo numeric
)
language sql stable security definer set search_path = public
as $$
  with alvo as (
    select case when (public.usuario_e_gestao() or auth.jwt() is null)
                 and coalesce(p_operador_email,'') <> ''
                then lower(p_operador_email)
                else lower(coalesce(auth.jwt()->>'email','')) end e
  ),
  -- PERNA 1 -- FICHA/MENSALIDADE. Identica a de antes.
  -- Conta por CPF, nao por ficha: aluno com ficha duplicada e uma pessoa so.
  -- Sem CPF, cai no id do caso para nao sumir da conta.
  ficha as (
    select c.operador_email, c.operador_nome,
           coalesce(nullif(lpad(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D','','g'), 11, '0'), '00000000000'),
                    c.id::text) chave,
           coalesce(s.saldo_mensalidade,0) mens,
           -- saldo de acordo DO ALUNO (de quem quer que seja o acordo). Fato
           -- financeiro da ficha: mensalidade renegociada em acordo nao pode
           -- ser cobrada duas vezes, entao ela nao entra em "a cobrar".
           coalesce(s.saldo_acordo,0) acordo_do_aluno
      from public.casos c
      join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id, alvo
     where lower(c.operador_email) = alvo.e
       and coalesce(s.saldo_total,0) > 0
       and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
             c.status_acionamento, c.status_financeiro, c.status_jornada)
  ),
  -- PERNA 2 -- ACORDO. Mesmo universo de acordo/parcela que
  -- calibragem_saldo_aluno usa (acordo nao cancelado, parcela em aberto), mas
  -- agrupado pelo DONO DO ACORDO, nao pelo dono da ficha.
  acordo as (
    select coalesce(nullif(lpad(regexp_replace(coalesce(al.cpf,''), '\D','','g'), 11, '0'), '00000000000'),
                    al.id::text) chave,
           sum(coalesce(p.valor,0)) saldo
      from public.acordos a
      join public.alunos al on al.id = a.aluno_id
      join public.parcelas p on p.acordo_id = a.id, alvo
     where lower(nullif(trim(coalesce(a.operador_responsavel_email,'')), '')) = alvo.e
       and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
       and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
     group by 1
  ),
  nums as (
    select
      (select max(operador_email) from ficha) as email_ficha,
      (select max(operador_nome)  from ficha) as nome_ficha,
      (select count(distinct chave) from ficha where mens > 0 and acordo_do_aluno = 0)::int as so_mensalidade,
      (select count(*) from acordo)::int as com_acordo,
      (select count(*) from acordo ac
         where exists (select 1 from ficha f where f.chave = ac.chave and f.mens > 0))::int as acordo_e_mensalidade,
      (select count(*) from (select chave from ficha union select chave from acordo) u)::int as total,
      (select round(coalesce(sum(mens),0), 2) from ficha where acordo_do_aluno = 0) as v_mensalidade,
      (select round(coalesce(sum(saldo),0), 2) from acordo) as v_acordo,
      (select count(*) from ficha) + (select count(*) from acordo) as linhas
  )
  select
    coalesce(n.email_ficha, u.email, nullif((select e from alvo), '')),
    coalesce(n.nome_ficha, u.nome, nullif((select e from alvo), '')),
    n.so_mensalidade, n.com_acordo, n.acordo_e_mensalidade, n.total,
    n.v_mensalidade, n.v_acordo
  from nums n
  left join public.usuarios u on lower(u.email) = (select e from alvo)
  where n.linhas > 0;
$$;

revoke all on function public.minha_carteira_resumo(text) from public, anon;
grant execute on function public.minha_carteira_resumo(text) to authenticated;

comment on function public.minha_carteira_resumo(text) is
  'Resumo da propria carteira em duas pernas separadas: FICHA/MENSALIDADE por casos.operador_email e ACORDO por acordos.operador_responsavel_email. Operador ve so o seu; gestao pode passar o e-mail de outro.';

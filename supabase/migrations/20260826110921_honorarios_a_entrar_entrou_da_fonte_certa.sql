-- "Entrou" tem de ler o honorário que entrou de verdade.
--
-- O ERRO. A tela somava `parcelas.honorarios` das parcelas pagas. Só que esse
-- campo quase nunca está preenchido: de 1.484 parcelas pagas, apenas 116 (7,8%)
-- têm honorário na parcela, somando R$ 5.178. O honorário de verdade mora em
-- `pagamentos.valor_honorario`, que vem da importação do Santander: 8.007
-- pagamentos com honorário, R$ 837.486.
--
-- Ou seja: o operador via R$ 5 mil onde entraram R$ 837 mil. Duas ordens de
-- grandeza -- e, pior, um número que não batia com a Projeção, que é por onde
-- ele é cobrado. Duas telas discordando sobre o mesmo fato fazem ninguém
-- confiar em nenhuma das duas.
--
-- A CORREÇÃO. O estado PAGO passa a sair de `pagamentos`, com o MESMO filtro da
-- Projeção (projecao_calcular_operador): soma de valor_honorario por
-- data_pagamento e operador_email. Assim as duas telas concordam por
-- construção, não por coincidência -- se a Projeção mudar de regra, as duas
-- mudam juntas. Conferido operador a operador no mês corrente: diferença zero.
--
-- A_VENCER e VENCIDO continuam vindo das parcelas, que é onde de fato mora o
-- que AINDA pode entrar. A regra da Amanda (26/08/2026) segue igual: honorário
-- de parcela a vencer entra se ela for paga; se não for, é quebra de acordo.
--
-- JANELA: 12 meses para trás no PAGO. É acompanhamento do que está entrando,
-- não histórico contábil -- e evita arrastar 8 mil linhas para a tela.

create or replace function public.honorarios_a_entrar(p_email text default null)
returns table(
  parcela_id uuid, acordo_id uuid, aluno_id uuid, aluno_nome text,
  operador_email text, numero integer, vencimento date, valor numeric,
  honorario numeric, estado text, acordo_total numeric, is_entrada boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_gestao boolean := false;
  v_alvo   text;
begin
  begin
    v_gestao := coalesce(public.usuario_e_gestao(), false);
  exception when others then
    v_gestao := false;
  end;

  v_alvo := case
              when v_gestao then nullif(lower(coalesce(p_email,'')), '')
              else nullif(v_email, '')
            end;

  return query
  -- O QUE AINDA PODE ENTRAR (e o que a quebra levou): das parcelas.
  select
    p.id, a.id, a.aluno_id,
    coalesce(al.nome, '-'),
    lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')),
    p.numero,
    p.vencimento,
    round(coalesce(p.valor,0), 2),
    round(coalesce(p.honorarios,0), 2),
    case when p.vencimento < current_date then 'VENCIDO' else 'A_VENCER' end,
    round(coalesce(a.valor_total,0), 2),
    coalesce(p.is_entrada, false)
  from public.parcelas p
  join public.acordos a on a.id = p.acordo_id
  left join public.alunos al on al.id = a.aluno_id
  where a.status = 'ATIVO'
    and coalesce(p.status,'') not in ('CANCELADA','PAGO')
    and (
      v_alvo is null
      or lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')) = v_alvo
    )

  union all

  -- O QUE ENTROU: de pagamentos, a mesma fonte e o mesmo filtro da Projeção.
  -- Sem parcela_id porque `pagamentos` não guarda vínculo com parcela -- e o
  -- número certo não depende desse vínculo.
  select
    null::uuid, null::uuid, pg.aluno_id,
    coalesce(pg.aluno_nome, al2.nome, '-'),
    lower(coalesce(pg.operador_email, '')),
    null::integer,
    pg.data_pagamento,
    round(coalesce(pg.valor_pago,0), 2),
    round(coalesce(pg.valor_honorario,0), 2),
    'PAGO',
    null::numeric,
    coalesce(pg.entrada_paga, false)
  from public.pagamentos pg
  left join public.alunos al2 on al2.id = pg.aluno_id
  where pg.data_pagamento >= (date_trunc('month', current_date) - interval '11 months')::date
    and (v_alvo is null or lower(coalesce(pg.operador_email,'')) = v_alvo)

  order by 7, 4;
end;
$function$;

comment on function public.honorarios_a_entrar(text) is
  'O que tenho para entrar. A_VENCER/VENCIDO vem das parcelas dos acordos ativos; PAGO vem de pagamentos.valor_honorario -- a MESMA fonte e o mesmo filtro da Projecao, para as duas telas nunca discordarem. Antes o PAGO somava parcelas.honorarios, preenchido em so 7,8% das parcelas pagas: mostrava R$ 5 mil onde entraram R$ 837 mil.';

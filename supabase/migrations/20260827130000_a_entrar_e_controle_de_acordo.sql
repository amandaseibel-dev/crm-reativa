-- "O que tenho a entrar" é controle de ACORDO, não de pagamento.
--
-- Amanda, 27/08/2026: "lá é só o que está pendente de acordo a entrar, o que já
-- está vencido, um controle dos acordos".
--
-- O QUE EU TINHA ERRADO. Ontem, ao corrigir o card "Entrou" (que somava
-- parcelas.honorarios, preenchido em 7,8% dos casos), fiz o estado PAGO ler
-- `pagamentos` -- a mesma fonte da Projeção. O número ficou certo como
-- "honorário que entrou no mês", mas MUDOU O ASSUNTO da tela: passou a incluir
-- pagamento de mensalidade, que não é acordo.
--
-- A tela é o acompanhamento do acordo do operador: o que está por vencer, o que
-- venceu (quebra) e o que foi pago. Três estados da MESMA coisa -- a parcela.
--
-- Os três voltam a sair de `parcelas`, com uma diferença importante no estado
-- PAGO: o honorário vem primeiro da BAIXA (honorarios_recebidos, o que de fato
-- entrou) e só cai para parcelas.honorarios quando não há baixa. Era isso que
-- faltava na versão original -- ela lia só a parcela e mostrava quase zero.
--
-- Agosto, o que a tela passa a mostrar:
--     a vencer   292 parcelas   R$   415.330,04
--     entrou      83 parcelas   R$   204.377,21
--     vencida    953 parcelas   R$ 1.305.966,34   <- a quebra
--
-- Julho tem outras 733 vencidas (R$ 1.086.014,39). Esse é o número que o
-- operador precisa ver e que estava diluído.

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
  select
    p.id, a.id, a.aluno_id,
    coalesce(al.nome, '-'),
    lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')),
    p.numero,
    p.vencimento,
    round(coalesce(p.valor,0), 2),
    -- Pago: vale o que ENTROU (baixa). Nos demais, o combinado da parcela.
    case when upper(coalesce(p.status,'')) = 'PAGO'
         then round(coalesce(
                (select sum(coalesce(b.honorarios_recebidos,0))
                   from public.baixas_pagamento b
                  where b.parcela_id = p.id and b.status_baixa = 'REALIZADA'),
                coalesce(p.honorarios,0)), 2)
         else round(coalesce(p.honorarios,0), 2)
    end,
    case when upper(coalesce(p.status,'')) = 'PAGO' then 'PAGO'
         when p.vencimento < current_date then 'VENCIDO'
         else 'A_VENCER'
    end,
    round(coalesce(a.valor_total,0), 2),
    coalesce(p.is_entrada, false)
  from public.parcelas p
  join public.acordos a on a.id = p.acordo_id
  left join public.alunos al on al.id = a.aluno_id
  where a.status = 'ATIVO'
    and coalesce(p.status,'') <> 'CANCELADA'
    and (
      v_alvo is null
      or lower(coalesce(nullif(a.operador_responsavel_email,''), al.responsavel_atual_email, '')) = v_alvo
    )
  order by p.vencimento, al.nome;
end;
$function$;

comment on function public.honorarios_a_entrar(text) is
  'Controle dos acordos do operador: parcelas dos acordos ATIVOS em tres estados -- A_VENCER (pode entrar), VENCIDO (quebra) e PAGO (entrou). Tudo sai de parcelas, porque os tres sao estados da mesma coisa. No PAGO o honorario vem da BAIXA (honorarios_recebidos, o que de fato entrou) e so cai para parcelas.honorarios quando nao ha baixa. NAO mistura pagamento de mensalidade -- isso e assunto da Projecao.';

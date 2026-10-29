-- Quem ja foi acionado, dentro da propria aba.
--
-- Amanda, 27/08/2026: "entrou, mas como o operador poderia dentro dessa aba,
-- identificar o que ja foi acionado".
--
-- O PROBLEMA. A aba virou lista de trabalho -- principalmente o estado VENCIDO,
-- que em agosto tem 953 parcelas e em julho 733. Mas ela nao dizia quem ja
-- tinha sido acionado. O operador abre a lista, liga, e nao tem como saber que
-- ligou para o mesmo aluno anteontem -- a informacao esta na ficha, e voltar na
-- ficha de cada um derrota o proposito da lista.
--
-- O QUE PASSA A VIR JUNTO, por linha:
--   ultimo_acionamento   -- a data do ultimo acionamento do aluno
--   dias_sem_acionamento -- quantos dias faz (null = nunca acionado)
--   tabulacao            -- o que foi registrado da ultima vez
--
-- Tudo do cadastro do aluno, que e onde o acionamento e gravado -- conferido
-- em 27/08: dos 630 alunos tabulados no dia anterior, 625 estavam com a data
-- atualizada, entao a fonte e confiavel.
--
-- Nada foi tirado nem recalculado: sao tres colunas a mais no retorno.
-- Precisa de DROP porque mudar o retorno de uma funcao existente nao e permitido.

drop function if exists public.honorarios_a_entrar(text);

create function public.honorarios_a_entrar(p_email text default null)
returns table(
  parcela_id uuid, acordo_id uuid, aluno_id uuid, aluno_nome text,
  operador_email text, numero integer, vencimento date, valor numeric,
  honorario numeric, estado text, acordo_total numeric, is_entrada boolean,
  ultimo_acionamento date, dias_sem_acionamento integer, tabulacao text
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
    coalesce(p.is_entrada, false),
    -- Quem ja foi acionado: a lista precisa dizer, senao o operador liga duas
    -- vezes para a mesma pessoa.
    al.data_ultimo_acionamento::date,
    case when al.data_ultimo_acionamento is null then null
         else (current_date - al.data_ultimo_acionamento::date)::integer end,
    nullif(btrim(coalesce(al.status_acionamento,'')), '')
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
  'Controle dos acordos do operador: parcelas dos acordos ATIVOS em tres estados -- A_VENCER, VENCIDO (quebra) e PAGO. Devolve tambem ultimo_acionamento, dias_sem_acionamento e a tabulacao, para o operador ver na propria lista quem ja foi acionado e nao ligar duas vezes. No PAGO o honorario vem da BAIXA (o que de fato entrou).';

revoke all on function public.honorarios_a_entrar(text) from public;
grant execute on function public.honorarios_a_entrar(text) to authenticated;

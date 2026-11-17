-- Prioridade do Acionamento Guiado: alunos com mensalidade de 2026 recebida
-- por borderô, saldo aberto, elegíveis e SEM acionamento registrado desde a
-- entrada desse borderô.
--
-- Somente leitura: não grava nada e não duplica dado armazenado. Lê os
-- títulos (acordos_titulos + importacoes), a elegibilidade canônica
-- (aluno_elegibilidade_cobranca) e as movimentações desde a entrada.
--
-- Regras:
--   - contato ANTERIOR à entrada do borderô NÃO conta como acionamento
--     (a dívida entrou depois; o contato antigo não trabalhou este lote);
--   - bloqueio efetivo (suspensão, cancelamento, jurídico, não acionar)
--     e pagamento/comprovante pendente são sinalizados para exclusão do guiado;
--   - a fidelização não aparece aqui: ela não impede o próprio responsável.
--
-- Fuso: importacoes.created_at é tratado como horário de Brasília (America/Sao_Paulo).
-- Confirmar esta premissa antes da aplicação (ver PR).
--
-- Não aplicar em produção sem aprovação. Verificações de grant e search_path
-- seguem seguranca-rls.

create or replace function public.carteira_prioridade_bordero(
  p_operador_email text default null
)
returns table (
  cpf_limpo text,
  aluno_id uuid,
  entrada_bordero timestamptz,
  saldo_bordero_2026 numeric,
  elegivel boolean,
  bloqueado boolean,
  pagamento_pendente boolean,
  sem_acionamento_desde_entrada boolean
)
language sql
stable
security invoker
set search_path = public
as $function$
  with titulos as (
    select t.aluno_id,
           min((i.created_at at time zone 'America/Sao_Paulo')) as entrada,
           sum(coalesce(t.valor_em_aberto, t.saldo_corrigido, 0)) as saldo
      from public.acordos_titulos t
      join public.importacoes i on i.id = t.importacao_id
     where i.tipo = 'BORDERO'
       and t.situacao = 'ABERTO'
       and t.vencimento between date '2026-01-01' and date '2026-12-31'
     group by t.aluno_id
    having sum(coalesce(t.valor_em_aberto, t.saldo_corrigido, 0)) > 0
  ),
  base as (
    select tt.aluno_id, tt.entrada, tt.saldo, a.cpf,
           e.motivo_principal,
           e.elegivel as elegivel_canonica
      from titulos tt
      join public.alunos a on a.id = tt.aluno_id
      left join lateral public.aluno_elegibilidade_cobranca(tt.aluno_id) e on true
      left join public.casos c on c.aluno_id = tt.aluno_id and not coalesce(c.encerrado_operacional, false)
     where p_operador_email is null
        or lower(coalesce(c.responsavel_atual_email, a.responsavel_atual_email, '')) = lower(p_operador_email)
     group by tt.aluno_id, tt.entrada, tt.saldo, a.cpf, e.motivo_principal, e.elegivel
  )
  select
    regexp_replace(coalesce(b.cpf, ''), '\D', '', 'g') as cpf_limpo,
    b.aluno_id,
    b.entrada,
    b.saldo,
    coalesce(b.elegivel_canonica, false) and b.motivo_principal is null as elegivel,
    coalesce(b.motivo_principal in ('SUSPENSAO_COBRANCA', 'CANCELAMENTO_COBRANCA', 'JURIDICO', 'NAO_ACIONAR_EXPLICITO'), false) as bloqueado,
    coalesce(b.motivo_principal = 'CONFIRMACAO_PAGAMENTO_PENDENTE', false)
      or exists (
        select 1 from public.aluno_movimentacoes m
         where m.aluno_id = b.aluno_id::text
           and m.registrado_em >= b.entrada
           and m.tipo ~ 'PAGAMENTO|COMPROVANTE|BAIXA|CONFIRMACAO|QUITA'
      ) as pagamento_pendente,
    not exists (
      select 1 from public.aluno_movimentacoes m
       where m.aluno_id = b.aluno_id::text
         and m.registrado_em >= b.entrada
         and (public.eh_tipo_acionamento(m.tipo) or m.lote_id is not null)
    )
    and not exists (
      select 1 from public.whatsapp_conversas wc
        join public.whatsapp_mensagens wm on wm.conversa_id = wc.id
       where wc.aluno_id = b.aluno_id
         and coalesce(wm.timestamp_wa, wm.criado_em) >= b.entrada
         and (wm.direcao = 'ENTRADA' or (wm.direcao = 'SAIDA' and wm.status = 'ENVIADO'))
    ) as sem_acionamento_desde_entrada
  from base b;
$function$;

revoke all on function public.carteira_prioridade_bordero(text) from public;
revoke all on function public.carteira_prioridade_bordero(text) from anon;
grant execute on function public.carteira_prioridade_bordero(text) to authenticated;
grant execute on function public.carteira_prioridade_bordero(text) to service_role;

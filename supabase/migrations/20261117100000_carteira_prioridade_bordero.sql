-- Prioridade do Acionamento Guiado: alunos com mensalidade de 2026 recebida
-- por borderô, saldo aberto, elegíveis e SEM acionamento registrado desde a
-- entrada do borderô MAIS RECENTE desse aluno.
--
-- Somente leitura: não grava nada e não duplica dado armazenado.
--
-- Fuso (confirmado por leitura em 18/11/2026):
--   importacoes.created_at é timestamp SEM fuso e tem default now(); o
--   servidor está em UTC. Portanto o valor é UTC. Convertido com
--   `at time zone 'UTC'`, nunca por suposição de horário de Brasília.
--
-- Regras:
--   - usa a entrada MAIS RECENTE (max), não a primeira: um contato depois de
--     um borderô antigo não esconde títulos que entraram depois;
--   - contato ANTERIOR à entrada não conta como acionamento;
--   - pagamento pendente = estado ATUAL em conferência (solicitação de
--     confirmação aguardando), não evento histórico já resolvido;
--   - lote pendente = aluno está em lote de exportação ainda não confirmado
--     nem descartado (referência verificável, sem IDs fixos no código);
--   - bloqueio efetivo (suspensão, cancelamento, jurídico, não acionar).
--
-- Parâmetro p_cpf_limpo: revalidação de UM aluno antes de abrir a ficha.
-- Sem linha = aluno fora da população de prioridade (não bloqueia).
-- Erro = o cliente NÃO deve abrir a ficha (ausência de dado não é liberação).
--
-- Não aplicar em produção sem aprovação. Grants e search_path seguem seguranca-rls.

drop function if exists public.carteira_prioridade_bordero(text);

create or replace function public.carteira_prioridade_bordero(
  p_operador_email text default null,
  p_cpf_limpo text default null
)
returns table (
  cpf_limpo text,
  aluno_id uuid,
  entrada_bordero timestamptz,
  saldo_bordero_2026 numeric,
  elegivel boolean,
  bloqueado boolean,
  pagamento_pendente boolean,
  lote_pendente boolean,
  sem_acionamento_desde_entrada boolean
)
language sql
stable
security invoker
set search_path = public
as $function$
  with titulos as (
    select t.aluno_id,
           max((i.created_at at time zone 'UTC')) as entrada_mais_recente,
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
    select tt.aluno_id, tt.entrada_mais_recente as entrada, tt.saldo, a.cpf,
           e.motivo_principal, e.elegivel as elegivel_canonica
      from titulos tt
      join public.alunos a on a.id = tt.aluno_id
      left join lateral public.aluno_elegibilidade_cobranca(tt.aluno_id) e on true
     where (p_cpf_limpo is null or regexp_replace(coalesce(a.cpf, ''), '\D', '', 'g') = p_cpf_limpo)
       and (
         -- Escopo pela identidade do JWT. Só a gestão pode filtrar por outro
         -- operador; o parâmetro do cliente nunca amplia o escopo do operador.
         (public.usuario_e_gestao() and (
            p_operador_email is null
            or exists (
              select 1 from public.casos c
               where c.aluno_id = tt.aluno_id
                 and not coalesce(c.encerrado_operacional, false)
                 and lower(coalesce(c.responsavel_atual_email, '')) = lower(p_operador_email)
            )))
         or exists (
           select 1 from public.casos c
            where c.aluno_id = tt.aluno_id
              and not coalesce(c.encerrado_operacional, false)
              and lower(coalesce(c.responsavel_atual_email, '')) = lower(coalesce(auth.email(), ''))
         )
       )
  )
  select
    regexp_replace(coalesce(b.cpf, ''), '\D', '', 'g') as cpf_limpo,
    b.aluno_id,
    b.entrada,
    b.saldo,
    coalesce(b.elegivel_canonica, false) and b.motivo_principal is null as elegivel,
    coalesce(b.motivo_principal in ('SUSPENSAO_COBRANCA', 'CANCELAMENTO_COBRANCA', 'JURIDICO', 'NAO_ACIONAR_EXPLICITO'), false) as bloqueado,
    (
      coalesce(b.motivo_principal = 'CONFIRMACAO_PAGAMENTO_PENDENTE', false)
      or exists (
        select 1 from public.solicitacoes_confirmacao_pagamento s
         where s.aluno_id = b.aluno_id::text
           and s.status in ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
      )
    ) as pagamento_pendente,
    exists (
      select 1 from public.acoes_massivas_lotes l
       where l.confirmado_em is null
         and l.descartado_em is null
         and b.aluno_id::text = any (l.aluno_ids)
    ) as lote_pendente,
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

revoke all on function public.carteira_prioridade_bordero(text, text) from public;
revoke all on function public.carteira_prioridade_bordero(text, text) from anon;
grant execute on function public.carteira_prioridade_bordero(text, text) to authenticated;
grant execute on function public.carteira_prioridade_bordero(text, text) to service_role;

-- ROLLBACK (executar somente se a migration tiver sido aplicada e precisar ser revertida):
--   drop function if exists public.carteira_prioridade_bordero(text, text);
-- A função é somente leitura: o rollback não toca dado. A tela trata erro
-- da RPC como "guiado não abre", então remover a função não libera casos.

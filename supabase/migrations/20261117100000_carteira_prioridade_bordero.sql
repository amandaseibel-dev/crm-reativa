-- Decisão de prioridade e de exclusão do Acionamento Guiado, centralizada no banco.
--
-- Chave: aluno_id. Sem CPF no retorno.
-- Entrada: lista de aluno_id da carteira visível (o cliente envia em lotes).
-- Saída: UMA linha por aluno autorizado. Aluno sem linha = não autorizado ou
--   não consultado: o cliente trata como EXCLUÍDO (ausência nunca libera).
--
-- Autorização interna (SECURITY DEFINER, search_path fixo):
--   - o chamador precisa estar ATIVO em public.usuarios (pelo JWT);
--   - operador: só alunos com caso ativo sob a própria responsabilidade
--     ou aluno cujo responsável atual é ele;
--   - gestão (public.usuario_e_gestao()): pode consultar o escopo permitido.
--   Nenhuma tabela de lotes é aberta: a leitura de acoes_massivas_lotes
--   acontece aqui dentro, restrita aos alunos já autorizados.
--
-- Regras:
--   - PRIORIDADE (sobe na Fila inteligente): em população 2026 (títulos
--     abertos de borderô com vencimento em 2026, saldo > 0), elegível pela
--     elegibilidade canônica, sem bloqueio, sem pagamento pendente, sem lote
--     pendente e SEM acionamento desde a entrada mais recente desse aluno.
--   - Acionamento desde a entrada = os TRÊS tipos da PREMISSAS §9
--     (FINALIZACAO_ATENDIMENTO, ACAO_MASSIVA_EXTERNA, ACAO_MASSIVA_EXTERNA_EMAIL),
--     ou envio WhatsApp confirmado, ou resposta recebida. WhatsApp não consta
--     em §9; é tratado como evidência de contato porque o envio já ocorreu.
--   - EXCLUSÃO DO GUIADO (nunca abre a ficha): bloqueio efetivo; pagamento ou
--     confirmação PENDENTE (estado atual, não evento histórico); lote de
--     exportação não confirmado nem descartado (contato duplicado).
--   - Lote pendente NÃO conta como envio realizado.
--   - Resposta recebida e envio realizado são campos separados.
--   - Quitação NÃO é contato.
--   - eh_tipo_acionamento NÃO é alterada por esta migration.
--
-- Fuso: importacoes.created_at é timestamp sem fuso com default now(); o
-- servidor está em UTC. Convertido com `at time zone 'UTC'`.
--
-- Definições reais de dependências (lidas em produção, somente leitura,
-- 18/11/2026; ver docs/seguranca/propostas/carteira-prioridade-dependencias.md):
--   aluno_elegibilidade_cobranca(uuid) - SECURITY DEFINER, owner postgres,
--     search_path=public, md5 d87c10aac1d733bbf2bdd4683265f3e3.
--     ACL: postgres, service_role (authenticated NÃO tem EXECUTE; por isso
--     esta função a chama como definer).
--   usuario_e_gestao() - SECURITY DEFINER, owner postgres, search_path=public,
--     md5 af3d391f4234e6a352585777897568e4. ACL inclui authenticated.
--     Gestão = lista fixa de três e-mails no corpo da função.
--
-- Não aplicar em produção sem aprovação. Rollback abaixo.

create or replace function public.carteira_prioridade_bordero(p_aluno_ids uuid[])
returns table (
  aluno_id uuid,
  em_populacao_2026 boolean,
  prioridade boolean,
  exclui_guiado boolean,
  motivo_exclusao text,
  entrada_bordero timestamptz,
  saldo_bordero_2026 numeric,
  acionado_desde_entrada boolean,
  envio_realizado boolean,
  resposta_recebida boolean
)
language plpgsql
stable
security definer
set search_path = public
as $function$
#variable_conflict use_column
declare
  v_email text := lower(coalesce(auth.email(), ''));
  v_gestao boolean := public.usuario_e_gestao();
  v_ativo boolean;
begin
  if coalesce(array_length(p_aluno_ids, 1), 0) > 500 then
    raise exception 'lote acima de 500 ids: consulte em partes' using errcode = '22023';
  end if;
  select coalesce(bool_or(u.ativo), false) into v_ativo
    from public.usuarios u
   where lower(u.email) = v_email;
  if v_email = '' or not coalesce(v_ativo, false) then
    raise exception 'acesso negado: usuario inativo ou sem cadastro' using errcode = '42501';
  end if;

  return query
  with ids as (
    select distinct x as id from unnest(coalesce(p_aluno_ids, '{}'::uuid[])) x where x is not null
  ),
  autorizados as (
    select i.id
      from ids i
     where v_gestao
        or exists (
             select 1 from public.alunos a
              where a.id = i.id
                and lower(coalesce(a.responsavel_atual_email, '')) = v_email)
  ),
  titulos as (
    select t.aluno_id as tid,
           max((i.created_at at time zone 'UTC')) as entrada,
           sum(coalesce(t.valor_em_aberto, t.saldo_corrigido, 0)) as saldo
      from public.acordos_titulos t
      join public.importacoes i on i.id = t.importacao_id
     where i.tipo = 'BORDERO'
       and t.situacao = 'ABERTO'
       and t.vencimento between date '2026-01-01' and date '2026-12-31'
       and t.aluno_id in (select au.id from autorizados au)
     group by t.aluno_id
    having sum(coalesce(t.valor_em_aberto, t.saldo_corrigido, 0)) > 0
  ),
  base as (
    select au.id as bid,
           e.motivo_principal as motivo,
           coalesce(e.elegivel, false) as canon,
           tt.entrada as ent,
           coalesce(tt.saldo, 0) as saldo,
           (tt.tid is not null) as pop
      from autorizados au
      left join titulos tt on tt.tid = au.id
      left join lateral public.aluno_elegibilidade_cobranca(au.id) e on true
  ),
  flags as (
    select b.bid,
           b.pop,
           b.canon,
           b.motivo,
           b.ent,
           b.saldo,
           coalesce(b.motivo in ('SUSPENSAO_COBRANCA', 'CANCELAMENTO_COBRANCA', 'JURIDICO', 'NAO_ACIONAR_EXPLICITO'), false) as bloq,
           (
             coalesce(b.motivo = 'CONFIRMACAO_PAGAMENTO_PENDENTE', false)
             or exists (
               select 1 from public.solicitacoes_confirmacao_pagamento s
                where s.aluno_id = b.bid::text
                  and s.status in ('AGUARDANDO_CONFIRMACAO', 'PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
           ) as pagto,
           exists (
             select 1 from public.acoes_massivas_lotes l
              where l.confirmado_em is null
                and l.descartado_em is null
                and b.bid::text = any (l.aluno_ids)
           ) as lote,
           exists (
             select 1 from public.aluno_movimentacoes m
              where m.aluno_id = b.bid::text
                and m.registrado_em >= b.ent
                and m.tipo in ('FINALIZACAO_ATENDIMENTO', 'ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL')
           ) as acion,
           exists (
             select 1 from public.whatsapp_conversas wc
               join public.whatsapp_mensagens wm on wm.conversa_id = wc.id
              where wc.aluno_id = b.bid
                and coalesce(wm.timestamp_wa, wm.criado_em) >= b.ent
                and wm.direcao = 'SAIDA' and wm.status = 'ENVIADO'
           ) as envio_wa,
           exists (
             select 1 from public.whatsapp_conversas wc
               join public.whatsapp_mensagens wm on wm.conversa_id = wc.id
              where wc.aluno_id = b.bid
                and coalesce(wm.timestamp_wa, wm.criado_em) >= b.ent
                and wm.direcao = 'ENTRADA'
           ) as resp_wa
      from base b
  )
  select f.bid,
         f.pop,
         (f.pop and f.canon and f.motivo is null and not f.bloq and not f.pagto and not f.lote
            and f.saldo > 0 and not f.acion) as prioridade,
         (f.bloq or f.pagto or f.lote) as exclui_guiado,
         case
           when f.bloq then 'BLOQUEADO'
           when f.pagto then 'PAGAMENTO_PENDENTE'
           when f.lote then 'LOTE_PENDENTE'
           else null
         end as motivo_exclusao,
         f.ent,
         case when f.pop then f.saldo else null end,
         (f.acion or f.envio_wa or f.resp_wa) as acionado_desde_entrada,
         (f.envio_wa) as envio_realizado,
         (f.resp_wa) as resposta_recebida
    from flags f;
end;
$function$;

revoke all on function public.carteira_prioridade_bordero(uuid[]) from public;
revoke all on function public.carteira_prioridade_bordero(uuid[]) from anon;
revoke all on function public.carteira_prioridade_bordero(uuid[]) from service_role;
grant execute on function public.carteira_prioridade_bordero(uuid[]) to authenticated;

-- ROLLBACK (somente se aplicada e precisar ser revertida; não altera dado):
--   drop function if exists public.carteira_prioridade_bordero(uuid[]);
-- Sem a função, a tela não consegue revalidar: o guiado fica fechado (fail-closed).

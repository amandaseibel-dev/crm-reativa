-- ============================================================================
-- Vincular ACORDOS ATIVOS ao operador responsável
-- ============================================================================
-- 2.904 dos 3.018 acordos ativos estavam sem operador: 2.850 vieram da
-- "Importacao Acordos" direto como ATIVO e nunca passaram por confirmação no
-- CRM. Sem dono, ninguém faz a tratativa.
--
-- A autoria JÁ EXISTE na nossa base, só não estava ligada ao acordo. Este
-- backfill liga, na ordem de confiabilidade medida em 2026-08-24:
--
--   1. acordos.confirmado_por_email  -> quem confirmou é o dono (regra da
--                                       gestão). Cobre 54.
--   2. casos.operador_acordo         -> campo específico de acordo.    443
--   3. casos.operador_acordo_planilha-> idem, origem planilha.         341
--   4. casos.operador_email          -> quem atende o caso hoje.     1.225
--                                       Total: 2.063 acordos, R$ 10,69 mi.
--
-- POR QUE NÃO USAR casos.operador_base: é o operador da MENSALIDADE, não do
-- acordo. Dos 431 acordos em que as duas fontes existem, 262 (61%) DISCORDAM.
-- Caso Tayná Salomoni Pastório: operador_base = NATALY, mas o acordo é da
-- OLGA (confirmado pela gestão). Usar a base atribuiria errado em mais da
-- metade.
--
-- POR QUE A ORDEM 2/3 VEM ANTES DA 4: `operador_email` é quem atende HOJE, e
-- diverge da fonte específica do acordo em 578 casos contra 148 iguais (~80%).
-- Serve como último recurso -- para a tratativa acontecer -- mas perde para
-- qualquer campo que fale especificamente do acordo.
--
-- MARCADORES, NÃO PESSOAS: `operador_acordo` e a planilha guardam também
-- valores que não são nome de operador. Só aceitamos valor que casa com alguém
-- de `usuarios`, então marcador nunca vira operador. NADA é apagado da origem:
-- os campos em `casos` seguem intactos, apenas não são usados como nome.
--
-- O que de fato aparece entre os acordos ATIVOS sem dono (medido 2026-08-24):
--   DIRETO     312 acordos  -- o aluno negociou sem operador. NÃO é motivo para
--                              ficar órfão: 256 deles recebem o dono ATUAL do
--                              caso (R$ 989.743,73) e seguem para tratativa
--                              normalmente; 56 não têm nem isso.
--   DANIELE      2 acordos  -- saiu da empresa, não está em `usuarios`; 1 é
--                              salvo pelo operador atual do caso.
--   QUITADO      1
--   RECEPTIVO    1
-- 'JURIDICO' e 'CANCELAMENTO TOTAL DA COBRANCA' existem em `casos` mas NÃO
-- aparecem em nenhum acordo ATIVO -- estão fora do alcance deste backfill.
-- Nenhum desses casos está marcado `nao_acionar`, e as situações são normais
-- (ACORDO_EM_DIA, COBRANCA_VENCIDA): são carteira viva, não cobrança encerrada.
--
-- NÃO TOCA: os 114 acordos que já têm operador, nenhum acordo CANCELADO ou
-- QUITADO, e nada financeiro (saldo, parcela, título, situação).
-- Os 841 sem fonte ficam SEM VÍNCULO de propósito -- redistribuição é decisão
-- da gestão, não deste script.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Backup antes de escrever (padrão da casa)
-- ----------------------------------------------------------------------------
create table if not exists public._backup_acordos_vinculo_operador_20260824 as
select id, operador_responsavel_nome, operador_responsavel_email, now() as capturado_em
from public.acordos
where status = 'ATIVO';

alter table public._backup_acordos_vinculo_operador_20260824 enable row level security;
revoke all on public._backup_acordos_vinculo_operador_20260824 from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Backfill
-- ----------------------------------------------------------------------------
with u as (
  select nome, email,
         upper(translate(nome,'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ','aaaaeeiooouucAAAAEEIOOOUUC')) as chave
  from public.usuarios
  where perfil in ('operador','supervisor','administrativo','gerencia')
), apelido as (
  -- NATALI e Nataly são a mesma pessoa: mesmo e-mail (cobranca08).
  select nome, email, chave from u
  union all
  select nome, email, 'NATALI' from u where chave = 'NATALY'
), alvo as (
  select ac.id,
         upper(translate(coalesce(c.operador_acordo,''),
               'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ','aaaaeeiooouucAAAAEEIOOOUUC')) as k_acordo,
         upper(translate(coalesce(c.operador_acordo_planilha,''),
               'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ','aaaaeeiooouucAAAAEEIOOOUUC')) as k_planilha,
         c.operador_email,
         ac.confirmado_por_email
  from public.acordos ac
  left join public.casos c on c.aluno_id = ac.aluno_id
  where ac.status = 'ATIVO'
    and ac.operador_responsavel_nome is null   -- não mexe em quem já tem dono
), escolha as (
  select alvo.id,
         coalesce(uc.nome,  a1.nome,  a2.nome,  uo.nome)  as nome,
         coalesce(uc.email, a1.email, a2.email, uo.email) as email
  from alvo
  left join apelido a1 on a1.chave = alvo.k_acordo
  left join apelido a2 on a2.chave = alvo.k_planilha
  left join u uo on uo.email = alvo.operador_email
  left join u uc on uc.email = alvo.confirmado_por_email
)
update public.acordos ac
   set operador_responsavel_nome  = e.nome,
       operador_responsavel_email = e.email,
       atualizado_em              = now()
  from escolha e
 where e.id = ac.id
   and e.email is not null;

-- ----------------------------------------------------------------------------
-- Daqui para a frente: quem confirma o acordo vira o dono, automaticamente
-- ----------------------------------------------------------------------------
-- Fecha a torneira: nenhum acordo novo nasce órfão se passar por confirmação.
create or replace function public.acordo_dono_ao_confirmar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Só preenche o que está vazio: dono já definido nunca é sobrescrito.
  if new.confirmado_por_email is not null
     and new.operador_responsavel_nome is null then
    select u.nome, u.email
      into new.operador_responsavel_nome, new.operador_responsavel_email
      from public.usuarios u
     where u.email = new.confirmado_por_email
     limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists acordo_dono_ao_confirmar_trg on public.acordos;
create trigger acordo_dono_ao_confirmar_trg
  before insert or update of confirmado_por_email on public.acordos
  for each row execute function public.acordo_dono_ao_confirmar();

comment on function public.acordo_dono_ao_confirmar() is
  'Ao confirmar um acordo, grava quem confirmou como operador responsável -- se ainda não houver um. Nunca sobrescreve dono já definido.';

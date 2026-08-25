-- Histórico de confirmações: mostrar QUEM fez e CONTAR o que a pessoa fez.
--
-- Dois problemas medidos em prod (2026-08-25):
--
-- 1) NOME. A tela mostrava "Amanda" porque a RPC preferia `usuarios.apelido`.
--    Só que existem DUAS Amandas no sistema (Amanda Seibel = gerência,
--    amanda.seibel@; Amanda Borges = administrativo, cobranca07@, apelido
--    "Amandinha"). Num registro de auditoria, apelido não serve. A correção vem
--    por uma coluna NOVA `usuarios.nome_exibicao` -- `nome` e `apelido` ficam
--    intactos, e as telas do dia a dia não mudam.
--
-- 2) CONTAGEM. A RPC só contava status = 'PAGAMENTO_CONFIRMADO', então todo o
--    resto do trabalho da fila ficava invisível. Na base: 2.990 conclusões como
--    saldo zero (todas com autor) e 226 rejeições simplesmente não apareciam.
--    Agora cada dia é aberto por AÇÃO: confirmado, saldo zero, rejeitado.
--
-- E os 1.057 'PAGAMENTO_CONFIRMADO' sem `confirmado_por` não são de ninguém:
-- são a faxina automática ("Confirmado automaticamente (aluno quitado/baixado)").
-- Apareciam como um "-" que parecia gente. Passam a se identificar como
-- automáticos, separados do trabalho das pessoas.
--
-- Só leitura + uma coluna nova de exibição. NÃO altera status, valores, filas,
-- permissões, nem `usuarios.nome`/`apelido`.
-- Rollback: supabase/rollbacks/20260825170000_historico_confirmacoes_autor_e_acao.rollback.sql

------------------------------------------------------------------------------
-- 1) Nome de exibição (coluna NOVA -- não se mexe em `nome`)
------------------------------------------------------------------------------
-- ATENÇÃO: `usuarios.nome` NÃO pode ser editado de leve. Existe o trigger
-- trg_usuarios_sincronizar_nome (AFTER UPDATE OF nome) que PROPAGA o novo nome
-- para registros históricos -- inclusive baixas_pagamento. Tentar renomear a
-- Amanda Seibel por ali falha com `acordo_quitado_operacao_nao_permitida`
-- (guard _bloquear_baixa_acordo_encerrado), e mesmo se passasse estaria
-- reescrevendo histórico já fechado. Não é o que se quer.
--
-- Então entra uma coluna separada só para EXIBIÇÃO. O trigger não a observa,
-- nada histórico é reescrito, e quem não tiver nome_exibicao segue como antes.
alter table public.usuarios
  add column if not exists nome_exibicao text;

comment on column public.usuarios.nome_exibicao is
  'Nome para telas de auditoria/histórico quando `nome` é ambíguo (ex.: duas Amandas). Não propaga para registros históricos, ao contrário de `nome`.';

-- Duas Amandas no sistema: Amanda Seibel (gerência) e Amanda Borges
-- (administrativo, apelido "Amandinha"). Só "Amanda" não identifica ninguém.
update public.usuarios
   set nome_exibicao = 'Amanda Seibel'
 where lower(email) = 'amanda.seibel@aelbra.com.br'
   and nome_exibicao is distinct from 'Amanda Seibel';

update public.usuarios
   set nome_exibicao = 'Amanda Borges'
 where lower(email) = 'cobranca07@aelbra.com.br'
   and nome_exibicao is distinct from 'Amanda Borges';

------------------------------------------------------------------------------
-- 2) Histórico por dia, por pessoa e por AÇÃO
------------------------------------------------------------------------------
drop function if exists public.historico_confirmacoes_por_dia();

create or replace function public.historico_confirmacoes_por_dia()
  returns table(dia date, usuario text, email text, acao text, automatico boolean, qtd bigint)
  language sql
  stable
  security definer
  set search_path to 'public'
as $function$
  with base as (
    select
      (s.confirmado_em at time zone 'America/Sao_Paulo')::date as dia,
      lower(nullif(btrim(coalesce(s.confirmado_por, '')), '')) as email_autor,
      case
        when s.status = 'PAGAMENTO_CONFIRMADO'                          then 'CONFIRMADO'
        when s.status in ('CONCLUIDA_SALDO_ZERO','ENCERRADO_SALDO_ZERO') then 'SALDO_ZERO'
        when s.status = 'PAGAMENTO_REJEITADO'                            then 'REJEITADO'
      end as acao
    from public.solicitacoes_confirmacao_pagamento s
    where s.confirmado_em is not null
      and s.status in ('PAGAMENTO_CONFIRMADO','CONCLUIDA_SALDO_ZERO',
                       'ENCERRADO_SALDO_ZERO','PAGAMENTO_REJEITADO')
      and (s.confirmado_em at time zone 'America/Sao_Paulo')::date
          >= (now() at time zone 'America/Sao_Paulo')::date - 30
  )
  select
    b.dia,
    -- Nome completo (auditoria). Apelido só entra se não houver nome.
    case when b.email_autor is null then 'Automático (sistema)'
         else coalesce(nullif(u.nome_exibicao,''), nullif(u.nome,''),
                       nullif(u.apelido,''), b.email_autor)
    end as usuario,
    coalesce(b.email_autor, '-') as email,
    b.acao,
    (b.email_autor is null) as automatico,
    count(*) as qtd
  from base b
  left join public.usuarios u on lower(u.email) = b.email_autor
  where b.acao is not null
  group by 1, 2, 3, 4, 5
  order by 1 desc, 6 desc;
$function$;

revoke all on function public.historico_confirmacoes_por_dia() from public, anon;
grant execute on function public.historico_confirmacoes_por_dia() to authenticated, service_role;

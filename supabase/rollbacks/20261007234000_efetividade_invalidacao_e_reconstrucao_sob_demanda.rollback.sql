-- ROLLBACK de 20261007234000_efetividade_invalidacao_e_reconstrucao_sob_demanda.
--
-- Desfaz a invalidacao por evento e devolve a politica de atualizacao ao estado
-- de 20261007230000: a fotografia passa a ser reconstruida SO pelo cron das :40,
-- e a Efetividade/Fila Unica voltam a poder ficar ate uma hora mostrando estado
-- anterior a pagamento, acordo, baixa, ajuste ou resolucao de pendencia.
--
-- NAO HA DADO FINANCEIRO A RESTAURAR. A migration revertida nao escreve em
-- `pagamentos`, `parcelas`, `acordos` nem `acordos_titulos`: ela so acrescentou
-- gatilhos que marcavam "refazer a foto", a tabela dessas marcas e o dreno. O
-- que se perde ao reverter e a marca pendente -- e perde-la e inofensivo, porque
-- o cron das :40 reconstroi tudo de qualquer forma.
--
-- ORDEM IMPORTA: os gatilhos saem ANTES das funcoes que eles chamam, senao uma
-- escrita em tabela financeira no intervalo chamaria funcao inexistente e
-- abortaria -- exatamente o que a migration se cuidou para nunca fazer.

begin;

-- 1. Os gatilhos primeiro.
drop trigger if exists trg_efetividade_invalidar_pagamentos on public.pagamentos;
drop trigger if exists trg_efetividade_invalidar_parcelas   on public.parcelas;
drop trigger if exists trg_efetividade_invalidar_acordos    on public.acordos;
drop trigger if exists trg_efetividade_invalidar_titulos    on public.acordos_titulos;

-- 2. O dreno sai do cron. As :40 ficam -- e voltam a ser a UNICA atualizacao.
select cron.unschedule('carteira_efetividade_dreno')
 where exists (select 1 from cron.job where jobname = 'carteira_efetividade_dreno');

-- 3. `carteira_efetividade_ler` volta ao corpo de 20261007230000, byte a byte:
--    sem `invalidado_em` e sem `atualizacao_pendente` no objeto `snapshot`.
--    O front revertido nao le esses campos; deixa-los seria inofensivo, mas o
--    rollback existe para devolver o estado anterior, nao uma mistura.
create or replace function public.carteira_efetividade_ler(
  p_bloco    text,
  p_ano      text,
  p_semestre text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_recorte text;
  v_out     jsonb;
begin
  if not public.carteira_2026_1_pode_ler() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if coalesce(p_bloco,'') not in ('seis_linhas','composicao_academica','pendencias_por_motivo') then
    raise exception 'Bloco desconhecido: %.', p_bloco using errcode = '22023';
  end if;

  v_recorte := case when p_ano = '2026' then p_ano || '/' || coalesce(p_semestre,'1') else p_ano end;

  select s.payload
         || jsonb_build_object('snapshot', jsonb_build_object(
              'gerado_em', s.gerado_em, 'duracao_ms', s.duracao_ms, 'bloco', s.bloco))
    into v_out
    from public.carteira_efetividade_snapshot s
   where s.bloco = p_bloco and s.recorte = v_recorte;

  -- Sem fotografia a tela precisa DIZER isso, nunca cair em bloco vazio -- que
  -- e indistinguivel de "nao ha dado".
  return coalesce(v_out, jsonb_build_object('sem_snapshot', true,
                                            'bloco', p_bloco, 'recorte', v_recorte));
end;
$function$;

comment on function public.carteira_efetividade_ler(text, text, text) is
  'Leitura rapida de um bloco da Efetividade. E a UNICA porta que o front usa para os '
  'tres blocos agregados -- ele nunca chama a funcao pesada. Devolve o payload da '
  'fotografia mais `snapshot.gerado_em`, ou {sem_snapshot:true}.';

revoke all on function public.carteira_efetividade_ler(text, text, text) from public, anon;
grant execute on function public.carteira_efetividade_ler(text, text, text) to authenticated, service_role;

-- 4. As funcoes novas e a tabela das marcas.
drop function if exists public.carteira_efetividade_solicitar_atualizacao();
drop function if exists public.carteira_efetividade_recalcular_pendentes();
drop function if exists public.tg_carteira_efetividade_invalidar();
drop function if exists public.carteira_efetividade_invalidar(text, text);
drop table if exists public.carteira_efetividade_invalidacao;

commit;

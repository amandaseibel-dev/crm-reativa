-- ROLLBACK de 20261007211500_parcela_devolvida_suspensa.
--
-- APLICAR PRIMEIRO, antes do rollback da fundacao (20261007210000).
--
-- Desfaz o MECANISMO. As LINHAS ja marcadas como DEVOLVIDA/SUSPENSA NAO sao
-- revertidas aqui: sao decisao da gestao sobre caso real, e derruba-las junto
-- com o mecanismo apagaria a decisao sem ninguem ter pedido. O bloco 8,
-- comentado, faz isso quando a gestao pedir, com a lista na mao.
--
-- ATENCAO A UMA ASSIMETRIA: se houver parcela com status DEVOLVIDA ou SUSPENSA
-- no momento do rollback, ela volta a ser considerada COBRAVEL -- porque
-- `parcela_viva` deixa de existir e as listas literais nao conhecem esses
-- status. Ou seja: o saldo dessas parcelas RESSUSCITA. O bloco 1 mede e avisa
-- antes de qualquer outra coisa, para que isso seja decisao e nao surpresa.

-- ---------------------------------------------------------------------------
-- 1. MEDICAO ANTES DE QUALQUER COISA
-- ---------------------------------------------------------------------------
do $medir$
declare v_n int; v_val numeric;
begin
  select count(*), coalesce(sum(coalesce(valor,0)),0) into v_n, v_val
    from public.parcelas where upper(coalesce(status,'')) in ('DEVOLVIDA','SUSPENSA');

  if v_n > 0 then
    raise warning 'ROLLBACK: % parcela(s) (R$ %) estao DEVOLVIDA/SUSPENSA e VOLTARAO AO SALDO depois deste rollback. Decida antes de seguir -- ver bloco 8.',
      v_n, v_val;
  else
    raise notice 'ROLLBACK: nenhuma parcela em DEVOLVIDA/SUSPENSA. Reversao do mecanismo nao mexe em saldo.';
  end if;
end
$medir$;

-- ---------------------------------------------------------------------------
-- 2. GATILHO E MOTORES
-- ---------------------------------------------------------------------------
drop trigger if exists trg_tabulacao_efeito_financeiro on public.alunos;
drop function if exists public.trg_tabulacao_efeito_financeiro();
drop function if exists public.parcela_efeito_sem_pagamento_aplicar(uuid, text, text, boolean);
drop function if exists public.suspensao_cobranca_reativar(uuid, text, boolean);

-- ---------------------------------------------------------------------------
-- 3. CATALOGO
-- ---------------------------------------------------------------------------
update public.tabulacoes
   set efeito_desfecho = null,
       atualizado_por = 'rollback 20261007211500', atualizado_em = now()
 where efeito_desfecho is not null;

delete from public.tabulacoes
 where codigo in ('ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO')
   and not exists (select 1 from public.alunos a where a.status_jornada = tabulacoes.codigo);

alter table public.tabulacoes drop constraint if exists tabulacoes_efeito_desfecho_valido;
alter table public.tabulacoes add constraint tabulacoes_efeito_desfecho_valido
  check (efeito_desfecho is null or efeito_desfecho = any (array['ANTECIPACAO_SEMESTRE']));

-- ---------------------------------------------------------------------------
-- 4. VOCABULARIO DA PARCELA
-- ---------------------------------------------------------------------------
alter table public.parcelas drop constraint if exists parcelas_efeito_coerente_com_status;
alter table public.parcelas drop constraint if exists parcelas_efeito_origem_valida;
alter table public.parcelas drop constraint if exists parcelas_efeito_sem_pagamento_valido;

-- As colunas FICAM: sao evidencia do que foi aplicado enquanto o mecanismo
-- existiu. Para remove-las de vez, depois de conferir que estao vazias:
--   alter table public.parcelas
--     drop column if exists efeito_sem_pagamento,
--     drop column if exists efeito_sem_pagamento_origem,
--     drop column if exists efeito_sem_pagamento_por,
--     drop column if exists efeito_sem_pagamento_em;

-- origem_baixa volta a aceitar ANTECIPACAO_SEMESTRE (estado de 07/10/2026).
alter table public.parcelas drop constraint if exists parcelas_origem_baixa_valida;
alter table public.parcelas add constraint parcelas_origem_baixa_valida
  check (origem_baixa is null or origem_baixa = any (array[
    'OPERADOR','ADM','GATILHO_IMPORTACAO','BAIXA_RELATORIO','IMPORTACAO_ACORDO',
    'AUTOMACAO','ANTECIPACAO_SEMESTRE']));

alter table public.acordos_titulos drop constraint if exists acordos_titulos_origem_encerramento_valida;
alter table public.acordos_titulos add constraint acordos_titulos_origem_encerramento_valida
  check (origem_encerramento is null or origem_encerramento = any (array[
    'CONFERENCIA_PRIME_ADMINISTRATIVA','ANTECIPACAO_SEMESTRE']));

-- ---------------------------------------------------------------------------
-- 5. ALERTA D-2
-- ---------------------------------------------------------------------------
-- Mesma guarda da migration: o subsistema de alerta D-2 nao existe em todo
-- banco (a fixture de teste monta um subconjunto do schema). Avisa quando pula.
do $alerta$
begin
  if to_regclass('public.acordo_alertas_parcela') is null then
    raise notice 'rollback: acordo_alertas_parcela nao existe neste banco; CHECK nao revertido.';
    return;
  end if;
  alter table public.acordo_alertas_parcela drop constraint if exists acordo_alertas_parcela_resolucao_check;
  alter table public.acordo_alertas_parcela add constraint acordo_alertas_parcela_resolucao_check
    check (resolucao = any (array['PAGA','ACORDO_QUITADO','ACORDO_CANCELADO','VENCIDA','SUBSTITUIDA','BLOQUEADO']));
end
$alerta$;

create or replace function public.tg_acordo_alerta_resolve_parcela()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  begin
    update public.acordo_alertas_parcela set resolvido_em = now(),
           resolucao = case when upper(coalesce(new.status,'')) = 'PAGO' then 'PAGA' else 'SUBSTITUIDA' end
     where parcela_id = new.id and resolvido_em is null;
  exception when others then
    begin
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('rotina', 'ALERTA_D2_RESOLVE_FALHOU', 'parcelas', new.id, jsonb_build_object('erro', SQLERRM, 'sqlstate', SQLSTATE));
    exception when others then null;
    end;
  end;
  return null;
end; $function$;

drop trigger if exists trg_acordo_alerta_resolve_parcela on public.parcelas;
create trigger trg_acordo_alerta_resolve_parcela
  after update of status on public.parcelas
  for each row
  when (upper(coalesce(new.status,'')) = any (array['PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO'])
        and new.status is distinct from old.status)
  execute function public.tg_acordo_alerta_resolve_parcela();

-- ---------------------------------------------------------------------------
-- 6. REVERTE OS PATCHES ANCORADOS
-- ---------------------------------------------------------------------------
do $patches$
declare v_def text; v_novo text;
begin
  -- 6.1 guarda de pagamento real sai de _acordo_fecha_com_a_ultima_parcela
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = '_acordo_fecha_com_a_ultima_parcela';
  if v_def ~ 'PAGAMENTO_REAL_OBRIGATORIO' then
    v_novo := regexp_replace(v_def,
      '\s*--\s*PAGAMENTO_REAL_OBRIGATORIO.*?and exists \(select 1 from public\.parcelas p where p\.acordo_id = a\.id\s*and upper\(coalesce\(p\.status,''''\)\) = ''PAGO''\)',
      '', 'is');
    if v_novo = v_def then
      raise warning 'rollback: nao consegui remover a guarda de PAGAMENTO_REAL_OBRIGATORIO; revisar _acordo_fecha_com_a_ultima_parcela a mao.';
    else
      execute v_novo;
    end if;
  end if;

  -- 6.2 os 3 codigos novos saem das funcoes de governanca
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = '_encerramento_so_gestao';
  if v_def ~ 'ALEGA_FIES_CONFIRMADO' then
    execute replace(v_def,
      ',''ALEGA_FIES_CONFIRMADO'',''ALEGA_CREDIES_CONFIRMADO'',''ALEGA_FINANCIAMENTO_CONFIRMADO''', '');
  end if;

  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'caso_encerrado_operacional';
  if v_def ~ 'ALEGA FIES CONFIRMADO' then
    execute replace(v_def,
      ',''ALEGA FIES CONFIRMADO'',''ALEGA CREDIES CONFIRMADO'',''ALEGA FINANCIAMENTO CONFIRMADO''', '');
  end if;

  select pg_get_functiondef(oid) into v_def from pg_proc where proname = '_talvez_quitar_aluno';
  if v_def ~ 'ALEGA_FIES_CONFIRMADO' then
    v_novo := replace(v_def,
      ',''ALEGA_FIES_CONFIRMADO'',''ALEGA_CREDIES_CONFIRMADO'',''ALEGA_FINANCIAMENTO_CONFIRMADO''', '');
    v_novo := replace(v_novo,
      'and coalesce(al.status_jornada,'''') in (''ANTECIPACAO_SEMESTRE'',''CANCELAMENTO_COBRANCA'',''SUSPENSAO_COBRANCA'')',
      'and coalesce(al.status_jornada,'''') = ''ANTECIPACAO_SEMESTRE''');
    execute v_novo;
  end if;
end
$patches$;

-- ---------------------------------------------------------------------------
-- 7. A FUNCAO DA ANTECIPACAO NAO E RECRIADA
-- ---------------------------------------------------------------------------
-- `antecipacao_semestre_aplicar` escrevia `PAGO`, que viola a regra 1. Ela nao
-- volta por este arquivo: para recria-la, aplicar de novo a migration
-- 20261007143000 -- e isso e uma decisao, nao um efeito colateral de rollback.

-- ---------------------------------------------------------------------------
-- 8. REVERTER AS LINHAS (COMENTADO -- so com pedido da gestao)
-- ---------------------------------------------------------------------------
-- Primeiro LISTE:
--   select a.aluno_id, a.efeito, a.origem, a.executado_em, a.executado_por, a.motivo,
--          a.parcelas_quitadas_qtd, a.parcelas_quitadas_valor,
--          a.titulos_encerrados_qtd, a.titulos_encerrados_valor, a.revertida_em
--     from public.parcela_efeito_sem_pagamento_auditoria a order by a.executado_em desc;
--
-- Depois, POR ALUNO (troque :aluno):
--
--   update public.parcelas p
--      set status = case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
--          efeito_sem_pagamento = null, efeito_sem_pagamento_origem = null,
--          efeito_sem_pagamento_por = null, efeito_sem_pagamento_em = null,
--          atualizado_em = now()
--     from public.acordos a
--    where a.id = p.acordo_id and a.aluno_id = :aluno
--      and upper(coalesce(p.status,'')) in ('DEVOLVIDA','SUSPENSA');
--
--   -- titulos: o encerramento administrativo e TERMINAL por gatilho
--   select set_config('conferencia_prime.decisao','on', true);
--   update public.acordos_titulos t
--      set situacao = 'ABERTO', status = 'em_aberto',
--          origem_encerramento = null, origem_encerramento_ref = null,
--          origem_encerramento_em = null, atualizado_em = now()
--    where t.aluno_id = :aluno
--      and t.origem_encerramento in ('CANCELAMENTO_COBRANCA','ANTECIPACAO_SEMESTRE',
--            'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO');
--   select set_config('conferencia_prime.decisao','off', true);
--
--   select public.recalcular_situacao_aluno(:aluno, 'rollback_devolvida_suspensa');

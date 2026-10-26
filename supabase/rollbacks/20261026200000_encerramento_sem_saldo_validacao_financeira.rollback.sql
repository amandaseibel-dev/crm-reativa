-- ROLLBACK: o texto volta a valer sozinho como prova de saldo zero.
--
-- Devolve ao texto EXATO de producao de 26/10/2026:
--   `caso_encerrado_operacional(5 args)`            md5 adc514c7a018018d866096d8e420d7b3
--   `casos_elegiveis_liberacao_fidelizacao()`       md5 fb72379bec0573059354843c3f82ddbd
--   `casos_reabrir_com_divida(int)`                 md5 63deeb34b039b9260c0d224b73d9ec81
-- e derruba o que a migration criou para ESCREVER e para decidir.
--
-- A TRILHA NAO E APAGADA. `caso_encerramento_sem_saldo` continua de pe, com o
-- gatilho de imutabilidade e a leitura `caso_encerramento_pendentes`: reverter
-- codigo nao apaga historico de decisao ja produzido. PITR nao esta habilitado
-- neste projeto, entao historico perdido nao volta.
--
-- CONSEQUENCIA A ENTENDER ANTES DE RODAR: com as funcoes antigas de volta, os
-- dois textos voltam a valer sozinhos e nenhuma delas consulta o congelamento.
-- Os alvos que tinham registro vigente continuam encerrados pelo proprio texto,
-- ou seja, o rollback NAO devolve ninguem a cobranca. O que se perde e a
-- conferencia financeira -- o defeito volta.

begin;

-- 1. A assinatura de 5 argumentos volta ao texto de producao.
create or replace function public.caso_encerrado_operacional(p_cpf text, p_status_atual text, p_status_acionamento text, p_status_financeiro text, p_status_jornada text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- + ANTECIPACAO SEMESTRE (07/10/2026). Entra pelo ramo condicional de propo-
  -- sito: `normalizar_status_acionamento` troca '_' por ' ', por isso sem under-
  -- score aqui.
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO','ANTECIPACAO SEMESTRE','ALEGA FIES CONFIRMADO','ALEGA CREDIES CONFIRMADO','ALEGA FINANCIAMENTO CONFIRMADO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq_acion) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- 2. O cron 8 volta ao texto de producao (sem a linha do congelamento).
create or replace function public.casos_elegiveis_liberacao_fidelizacao()
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text, data_ultimo_acionamento date, fidelizado_ate date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
    c.data_ultimo_acionamento,
    case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
  from public.casos c
  left join public.alunos a on a.id = c.aluno_id
  where c.operador_email is not null and lower(c.operador_email) <> internal.carteira_geral_email()
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$function$;

-- 3. O reabridor volta: patch ancorado reverso, uma linha.
do $patch$
declare
  v_def text; v_velho text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'casos_reabrir_com_divida';
  if v_def is null or position('caso_encerramento_congelado' in v_def) = 0 then
    raise notice 'casos_reabrir_com_divida: patch nao esta aplicado';
    return;
  end if;
  v_novo  := $novo$       -- 26/10/2026: congelado nao e tentado. Antes, ele era reaberto e o
       -- recalculo fechava de novo na mesma passagem, deixando um
       -- REABERTURA_DIVIDA_NOVA para um caso que nao reabriu.
       and not public.caso_encerramento_congelado(c.id)
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'$novo$;
  v_velho := $velho$       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'$velho$;
  if position(v_novo in v_def) = 0 then
    raise exception 'ROLLBACK_SEM_ANCORA em casos_reabrir_com_divida';
  end if;
  execute replace(v_def, v_novo, v_velho);
end;
$patch$;

-- 4. Sai o que escreve e o que decide.
drop function if exists public.caso_encerramento_resolver(uuid,text,text);
drop function if exists public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text);
drop function if exists public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text);
drop function if exists public._caso_sem_saldo_conferido(uuid,text);
drop function if exists public._encerramento_congelado(uuid,uuid,text);
drop function if exists public.caso_encerramento_congelado(uuid);
drop function if exists public._cpf11(text);

-- 5. FICA: a tabela, o gatilho de imutabilidade e a leitura
--    (`caso_encerramento_sem_saldo`, `_caso_encerramento_sem_saldo_imutavel`,
--    `caso_encerramento_pendentes`).
--
--    Para apagar a trilha -- o que NAO faz parte deste rollback -- e preciso
--    exportar antes e rodar, de proposito e em separado:
--
--      drop trigger trg_caso_encerramento_sem_saldo_imutavel on public.caso_encerramento_sem_saldo;
--      drop function public._caso_encerramento_sem_saldo_imutavel();
--      drop function public.caso_encerramento_pendentes(integer);
--      drop table public.caso_encerramento_sem_saldo;

commit;

-- ROLLBACK de 20261007143000_antecipacao_semestre_quita_responsabilidade.
--
-- O QUE ESTE ARQUIVO DESFAZ: o MECANISMO. Devolve a tabulacao a condicao de
-- alegacao, remove o gatilho, o motor e a coluna de catalogo, e restaura as tres
-- funcoes compartilhadas ao texto de producao de 07/10/2026.
--
-- O QUE ELE NAO DESFAZ, E POR QUE: as LINHAS ja escritas. Parcela quitada e
-- titulo encerrado por antecipacao sao decisao da gestao sobre um caso real --
-- derruba-las em bloco junto com o mecanismo apagaria a decisao sem ninguem ter
-- pedido. O bloco 6, comentado, faz essa reversao quando a gestao pedir, caso a
-- caso e com a lista na mao.
--
-- ORDEM: blocos 1 a 5 na sequencia. O bloco 1 (CHECK) FALHA DE PROPOSITO se ja
-- existir linha com os valores novos -- e o aviso de que ha dado para decidir
-- antes de voltar o vocabulario. Nesse caso: rode o bloco 6 primeiro, ou pule o
-- bloco 1 (deixar a lista maior nao muda comportamento nenhum).

-- ===== 1. VOCABULARIO ======================================================
alter table public.parcelas drop constraint if exists parcelas_origem_baixa_valida;
alter table public.parcelas add constraint parcelas_origem_baixa_valida
  check (origem_baixa is null or origem_baixa = any (array[
    'OPERADOR','ADM','GATILHO_IMPORTACAO','BAIXA_RELATORIO','IMPORTACAO_ACORDO','AUTOMACAO']));

alter table public.acordos_titulos drop constraint if exists acordos_titulos_origem_encerramento_valida;
alter table public.acordos_titulos add constraint acordos_titulos_origem_encerramento_valida
  check (origem_encerramento is null or origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA');

-- ===== 2. GATILHO E MOTOR ==================================================
drop trigger if exists trg_tabulacao_antecipacao_semestre on public.alunos;
drop function if exists public.trg_tabulacao_antecipacao_semestre();
drop function if exists public.antecipacao_semestre_aplicar(uuid, text, boolean);

-- ===== 3. CATALOGO =========================================================
-- Volta ao estado de 10/09/2026 (migration 20260910173223_tabulacoes_alegacao).
update public.tabulacoes
   set grupo = 'ALEGACAO',
       retorno_modo = 'DIAS_UTEIS',
       retorno_dias_uteis = 20,
       proxima_acao = 'AGUARDAR_RETORNO_UNIDADE',
       bloqueia_acionamento = true,
       somente_gestao = false,
       redireciona_para_email = 'cobranca07@aelbra.com.br',
       efeito_desfecho = null,
       atualizado_por = 'rollback 20261007143000',
       atualizado_em = now()
 where codigo = 'ANTECIPACAO_SEMESTRE';

alter table public.tabulacoes drop constraint if exists tabulacoes_efeito_desfecho_valido;
alter table public.tabulacoes drop column if exists efeito_desfecho;

-- ===== 4. AUDITORIA ========================================================
-- A tabela FICA: e evidencia do que foi aplicado enquanto o mecanismo existiu.
-- Para remove-la de vez, depois de conferir que esta vazia:
--   drop table if exists public.antecipacao_semestre_auditoria;

-- ===== 5. AS TRES FUNCOES, TEXTO DE PRODUCAO DE 07/10/2026 =================
create or replace function public._encerramento_so_gestao()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_encerra text[] := array['CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO'];
  v_novo text[];
  v_antigo text[];
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role'
                       or auth.jwt() is null
                       or session_user in ('postgres','reativa_responsavel_executor');
begin
  if v_sistema or coalesce(public.usuario_e_gestao(), false) then
    return new;
  end if;

  v_novo := array[upper(coalesce(new.status_atual,'')), upper(coalesce(new.status_jornada,'')),
                  upper(coalesce(new.status_acionamento,''))];
  v_antigo := array[upper(coalesce(old.status_atual,'')), upper(coalesce(old.status_jornada,'')),
                    upper(coalesce(old.status_acionamento,''))];

  -- So barra quando o encerramento e NOVO: reescrever o que ja estava la nao e
  -- o operador encerrando nada.
  if (v_novo && v_encerra) and not (v_antigo && v_encerra) then
    raise exception
      'Encerrar cobrança (cancelamento, suspensão ou jurídico) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text,
  p_status_financeiro text, p_status_jornada text)
returns boolean
language plpgsql stable set search_path to 'public'
as $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  -- status_acionamento fala do ACIONAMENTO. 'CANCELADO' aqui e acordo
  -- cancelado, nao cobranca cancelada -- e nao tira ninguem da fila.
  bloq_acion text[] := array['CANCELAMENTO COBRANCA','JURIDICO',
                             'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
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

create or replace function public._talvez_quitar_aluno(v_aluno uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_saldo numeric; v_parc int; v_conf int;
begin
  if v_aluno is null then return; end if;

  -- Titulo aguardando a Conferencia Prime nao e divida quitada: o aluno
  -- espera a decisao, nao vira QUITADO.
  if exists (select 1 from public.acordos_titulos
              where aluno_id = v_aluno and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO') then
    return;
  end if;

  select coalesce(sum(coalesce(saldo_corrigido, valor_original, 0)), 0) into v_saldo
    from public.acordos_titulos
   where aluno_id = v_aluno and upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO');
  if v_saldo > 0 then return; end if;

  select count(*) into v_parc
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where a.aluno_id = v_aluno
     and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO');
  if v_parc > 0 then return; end if;

  select count(*) into v_conf
    from public.solicitacoes_confirmacao_pagamento
   where aluno_id = v_aluno::text and status = 'AGUARDANDO_CONFIRMACAO';
  if v_conf > 0 then return; end if;

  update public.alunos
    set status_jornada = 'QUITADO', status_atual = 'QUITADO', status_acionamento = 'QUITADO',
        valor_em_aberto = 0
    where id = v_aluno
      and coalesce(status_jornada,'') not in ('QUITADO','QUITADO_MANUAL','JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA');

  update public.casos
     set status_financeiro = 'QUITADO_AUTOMATICO',
         quitado_em        = current_date,
         origem_quitacao   = 'QUITACAO_AUTOMATICA',
         total_em_aberto   = 0,
         criticidade       = 'NORMAL',
         caso_atualizado_por = 'sistema_quitacao_automatica',
         caso_atualizado_em  = now()
   where aluno_id = v_aluno
     and quitado_em is null
     and operador_email is not null;
end;
$function$;

-- ===== 6. REVERTER AS LINHAS (COMENTADO -- so com pedido da gestao) ========
-- Primeiro LISTE o que seria revertido:
--
--   select a.aluno_id, a.executado_em, a.executado_por, a.motivo,
--          a.parcelas_quitadas_qtd, a.parcelas_quitadas_valor,
--          a.titulos_encerrados_qtd, a.titulos_encerrados_valor
--     from public.antecipacao_semestre_auditoria a
--    order by a.executado_em desc;
--
-- Depois, POR ALUNO (troque :aluno), nesta ordem:
--
--   -- parcelas: volta a aberto. VENCIDA/A_VENCER pelo vencimento, como o resto
--   -- do CRM faz. `honorarios` nunca foi escrito pela antecipacao.
--   update public.parcelas p
--      set status = case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
--          pago_em = null, confirmado_por_email = null,
--          origem_baixa = null, origem_baixa_ref = null, origem_baixa_em = null,
--          atualizado_em = now()
--     from public.acordos a
--    where a.id = p.acordo_id and a.aluno_id = :aluno
--      and p.origem_baixa = 'ANTECIPACAO_SEMESTRE';
--
--   -- titulos: `_titulo_encerrado_administrativo_protegido` torna o
--   -- encerramento TERMINAL. Sem o set_config a reabertura e recusada em
--   -- silencio (com linha em public.auditoria).
--   select set_config('conferencia_prime.decisao','on', true);
--   update public.acordos_titulos t
--      set situacao = 'ABERTO', status = 'em_aberto',
--          origem_encerramento = null, origem_encerramento_ref = null,
--          origem_encerramento_em = null, atualizado_em = now()
--    where t.aluno_id = :aluno and t.origem_encerramento = 'ANTECIPACAO_SEMESTRE';
--   select set_config('conferencia_prime.decisao','off', true);
--
--   -- e o motor decide situacao, criticidade, proxima acao e retorno:
--   select public.recalcular_situacao_aluno(:aluno, 'rollback_antecipacao_semestre');

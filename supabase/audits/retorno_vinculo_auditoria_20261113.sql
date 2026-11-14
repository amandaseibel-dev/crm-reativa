-- ============================================================================
-- AUDITORIA DO VÍNCULO DE RETORNO — pedida pela gestão em 13/11/2026
-- ----------------------------------------------------------------------------
-- SOMENTE LEITURA. Não altera responsável, não movimenta caso, não escreve nada.
-- Rodar em produção (ahattpqrjmhkzsmnbdzs) quando houver conexão de leitura.
--
-- Responde, sem contar o mesmo caso duas vezes, às 6 perguntas da gestão:
--   1. casos com atendimento do responsável nos últimos 10 dias E fidelização
--      normal ausente ou desatualizada (mede a dessincronização);
--   2. quantos casos são protegidos SÓ pela via alternativa;
--   3. quantos dos retornos sem vínculo explícito seriam protegidos;
--   4. quantos dos casos antes auditados teriam proteção pela regra final;
--   5. quantos ganham proteção pela via explícita entre o 11º e o 15º dia;
--   6. se essa proteção adicional corresponde a retorno registrado durante
--      atendimento (tabulação que o gerou).
--
-- A regra final está em `public.aluno_retorno_operador_vigente` (migration
-- 20261112210000, PENDENTE). Como ela ainda NÃO existe em produção, este
-- arquivo repete o predicado em SQL, em `classificado`. Se a migration for
-- aplicada, o resultado tem de bater com a função.
--
-- CUSTO: consultas agregadas, uma passagem por `casos_elegiveis_liberacao_
-- fidelizacao()` e uma por `alunos` com retorno de operador. Sem varredura de
-- `aluno_movimentacoes` inteira: os EXISTS são por `aluno_id`.
-- ============================================================================

with hoje as (
  select (now() at time zone 'America/Sao_Paulo')::date as d
),

-- Casos que o cron considera elegíveis HOJE (fidelização normal já vencida).
elegivel as (
  select c.id as caso_id, c.aluno_id, c.cpf_limpo, c.data_ultimo_acionamento as dua,
         (c.giro_fidelizacao_ate is not null) as de_giro
    from public.casos_elegiveis_liberacao_fidelizacao() e
    join public.casos c on c.id = e.caso_id
   where c.aluno_id is not null
),

-- Alunos com retorno de operador vigente (hoje ou futuro, não concluído).
retorno as (
  select a.id as aluno_id, lower(a.responsavel_atual_email) as resp,
         a.data_retorno as ret, a.responsavel_atual_em as resp_em,
         h.d as hoje,
         exists (select 1 from public.usuarios u
                  where lower(u.email) = lower(a.responsavel_atual_email) and u.ativo) as resp_ativo
    from public.alunos a, hoje h
   where a.responsavel_atual_email is not null
     and a.data_retorno >= h.d
     and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
     and a.retorno_confirmado_em is null
),

-- Para cada aluno com retorno: o atendimento do responsável que sustenta cada via.
atendimento as (
  select r.*,
         -- via EXPLÍCITA: movimentação com a mesma data de retorno, até 15 dias
         (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
            from public.aluno_movimentacoes m
           where m.aluno_id = r.aluno_id::text
             and m.tipo = 'FINALIZACAO_ATENDIMENTO'
             and lower(m.registrado_por_email) = r.resp
             and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
             and (m.data_retorno at time zone 'America/Sao_Paulo')::date = r.ret) as dia_explicita,
         -- via ALTERNATIVA: atendimento do responsável nos últimos 10 dias
         (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
            from public.aluno_movimentacoes m
           where m.aluno_id = r.aluno_id::text
             and m.tipo = 'FINALIZACAO_ATENDIMENTO'
             and lower(m.registrado_por_email) = r.resp
             and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
             and m.registrado_em >= now() - interval '10 days') as dia_alternativa,
         -- a tabulação que gerou o retorno da via explícita (pergunta 6)
         (select m.status_novo
            from public.aluno_movimentacoes m
           where m.aluno_id = r.aluno_id::text
             and m.tipo = 'FINALIZACAO_ATENDIMENTO'
             and lower(m.registrado_por_email) = r.resp
             and (m.data_retorno at time zone 'America/Sao_Paulo')::date = r.ret
           order by m.registrado_em desc limit 1) as tabulacao_explicita
    from retorno r
),

classificado as (
  select a.*,
         -- explícita vale se o retorno está a no máximo 15 dias do atendimento
         (a.resp_ativo and a.dia_explicita is not null and a.ret <= a.dia_explicita + 15) as via_explicita,
         (a.resp_ativo and a.dia_alternativa is not null)                                  as via_alternativa
    from atendimento a
),

-- Junta com a elegibilidade: a fidelização NORMAL protege quem não é elegível.
caso_x_retorno as (
  select e.caso_id, e.aluno_id, e.de_giro, e.dua,
         coalesce(c.via_explicita, false)  as via_explicita,
         coalesce(c.via_alternativa, false) as via_alternativa,
         (c.aluno_id is not null)           as tem_retorno_operador,
         c.dia_alternativa, c.dia_explicita, c.ret, c.tabulacao_explicita
    from elegivel e
    left join classificado c on c.aluno_id = e.aluno_id
)

-- ---------------------------------------------------------------------------
-- BLOCO A — proteção dos casos ELEGÍVEIS (fidelização normal já não protege).
-- Sem dupla contagem: a explícita tem precedência sobre a alternativa.
-- ---------------------------------------------------------------------------
select 'A. elegiveis ao cron (fidelizacao normal NAO protege)' as bloco,
       'total' as item, count(*)::text as valor
  from caso_x_retorno
union all
select 'A. elegiveis ao cron (fidelizacao normal NAO protege)',
       'com retorno de operador vigente', count(*)::text
  from caso_x_retorno where tem_retorno_operador
union all
select 'A. elegiveis ao cron (fidelizacao normal NAO protege)',
       'protegidos SO pela via explicita', count(*)::text
  from caso_x_retorno where via_explicita
union all
select 'A. elegiveis ao cron (fidelizacao normal NAO protege)',
       'protegidos SO pela via alternativa (pergunta 2)', count(*)::text
  from caso_x_retorno where via_alternativa and not via_explicita
union all
select 'A. elegiveis ao cron (fidelizacao normal NAO protege)',
       'sem protecao: seriam liberados', count(*)::text
  from caso_x_retorno where not via_explicita and not via_alternativa
union all
select 'A. elegiveis ao cron (fidelizacao normal NAO protege)',
       'com retorno de operador e SEM protecao (os "62"; pergunta 4)', count(*)::text
  from caso_x_retorno where tem_retorno_operador and not via_explicita and not via_alternativa

-- ---------------------------------------------------------------------------
-- BLOCO B — pergunta 1: dessincronização. Atendimento recente do responsável
-- em caso que mesmo assim está elegível (o acionamento não acompanhou).
-- ---------------------------------------------------------------------------
union all
select 'B. dessincronizacao (pergunta 1)',
       'elegiveis COM atendimento do responsavel nos ultimos 10 dias', count(*)::text
  from caso_x_retorno where dia_alternativa is not null
union all
select 'B. dessincronizacao (pergunta 1)',
       'destes, dias entre o atendimento e o ultimo acionamento do caso',
       coalesce(string_agg(distinct (dia_alternativa - dua)::text, ', ' order by (dia_alternativa - dua)::text), '(nenhum)')
  from caso_x_retorno where dia_alternativa is not null

-- ---------------------------------------------------------------------------
-- BLOCO C — pergunta 5 e 6: proteção extra da via explícita no 11º a 15º dia.
-- ---------------------------------------------------------------------------
union all
select 'C. via explicita entre o 11o e o 15o dia (perguntas 5 e 6)',
       'casos elegiveis protegidos nessa faixa', count(*)::text
  from caso_x_retorno
 where via_explicita and (ret - dia_explicita) between 11 and 15
union all
select 'C. via explicita entre o 11o e o 15o dia (perguntas 5 e 6)',
       'tabulacao que gerou o retorno: ' || coalesce(tabulacao_explicita, '(sem)'), count(*)::text
  from caso_x_retorno
 where via_explicita and (ret - dia_explicita) between 11 and 15
 group by tabulacao_explicita

-- ---------------------------------------------------------------------------
-- BLOCO D — pergunta 3: TODOS os retornos de operador da base (não só os
-- elegíveis), separados por via. Aqui aparecem os "383 sem vínculo explícito".
-- ---------------------------------------------------------------------------
union all
select 'D. todos os retornos de operador vigentes (pergunta 3)',
       'total', count(*)::text from classificado
union all
select 'D. todos os retornos de operador vigentes (pergunta 3)',
       'responsavel INATIVO (nao protege, regra 5)', count(*)::text
  from classificado where not resp_ativo
union all
select 'D. todos os retornos de operador vigentes (pergunta 3)',
       'com vinculo EXPLICITO valido', count(*)::text
  from classificado where via_explicita
union all
select 'D. todos os retornos de operador vigentes (pergunta 3)',
       'SEM vinculo explicito, mas protegidos pela ALTERNATIVA', count(*)::text
  from classificado where not via_explicita and via_alternativa
union all
select 'D. todos os retornos de operador vigentes (pergunta 3)',
       'SEM vinculo explicito e SEM alternativa (nao protegidos)', count(*)::text
  from classificado where not via_explicita and not via_alternativa
order by 1, 2;

-- ============================================================================
-- MEDIÇÃO DO ESTOQUE ANTIGO DE RETORNOS — pedida pela gestão em 13/11/2026
-- ----------------------------------------------------------------------------
-- SOMENTE LEITURA. Nenhum insert/update/delete. Não movimenta caso nem altera
-- responsável. Rodar em produção quando a leitura estiver disponível.
--
-- Responde:
--   A. total de casos e alunos elegíveis à liberação;
--   B. quantos retornos antigos passam a ser PROTEGIDOS pela correção de 13/11
--      (vínculo gravado no TEXTO da movimentação, não no campo);
--   C. distribuição por responsável;
--   D. casos AMBÍGUOS — ficam FORA da liberação até esclarecimento.
--
-- Por que o vínculo por texto: até 13/11 a tela Minha Carteira gravava o retorno
-- no aluno e no texto do atendimento ("Retorno: DD/MM/AAAA"), mas não no campo
-- `data_retorno` da movimentação. A ausência do campo NÃO é prova de agendamento
-- automático. Os dois formatos valem, com o mesmo teto de 15 dias.
--
-- A regra final está em `public.aluno_retorno_operador_vigente` e a exclusão de
-- ambíguos em `public.aluno_retorno_ambiguo` (migration PENDENTE). Enquanto elas não
-- existirem em produção, o predicado é repetido aqui, com a MESMA lógica. Depois de
-- aplicada a migration, este arquivo e as funções têm de devolver o mesmo resultado —
-- é o que o teste de equivalência da suíte garante.
-- ============================================================================

with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),

elegivel as (
  select c.id as caso_id, c.aluno_id, c.cpf_limpo, lower(c.operador_email) as operador
    from public.casos_elegiveis_liberacao_fidelizacao() e
    join public.casos c on c.id = e.caso_id
   where c.aluno_id is not null
),

-- Retorno de operador vigente: hoje ou futuro, não concluído, responsável ativo.
retorno as (
  select a.id as aluno_id, lower(a.responsavel_atual_email) as resp, a.data_retorno as ret,
         a.responsavel_atual_em as resp_em,
         exists (select 1 from public.usuarios u
                  where lower(u.email) = lower(a.responsavel_atual_email) and u.ativo) as resp_ativo
    from public.alunos a, hoje h
   where a.responsavel_atual_email is not null
     and a.data_retorno >= h.d
     and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
     and a.retorno_confirmado_em is null
),

sinal as (
  select r.*,
    -- vínculo pelo CAMPO (formato novo, a partir de 13/11)
    (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
       from public.aluno_movimentacoes m
      where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
        and lower(m.registrado_por_email) = r.resp
        and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
        and (m.data_retorno at time zone 'America/Sao_Paulo')::date = r.ret) as dia_campo,
    -- vínculo pelo TEXTO (estoque antigo)
    (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
       from public.aluno_movimentacoes m
      where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
        and lower(m.registrado_por_email) = r.resp
        and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
        and m.descricao like '%Retorno: ' || to_char(r.ret, 'DD/MM/YYYY') || '%') as dia_texto,
    -- alternativa: atendimento do responsável nos últimos 10 dias
    (select max((m.registrado_em at time zone 'America/Sao_Paulo')::date)
       from public.aluno_movimentacoes m
      where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
        and lower(m.registrado_por_email) = r.resp
        and m.registrado_em >= coalesce(r.resp_em, '-infinity'::timestamptz)
        and m.registrado_em >= now() - interval '10 days') as dia_alt,
    -- SINAL DE AMBIGUIDADE: o responsável menciona retorno, mas com OUTRA data
    exists (select 1 from public.aluno_movimentacoes m
             where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
               and lower(m.registrado_por_email) = r.resp
               and m.descricao ilike '%retorno%'
               and m.descricao not like '%Retorno: ' || to_char(r.ret, 'DD/MM/YYYY') || '%') as menciona_outra_data,
    -- SINAL DE AMBIGUIDADE: nenhum atendimento do responsável atual
    not exists (select 1 from public.aluno_movimentacoes m
                 where m.aluno_id = r.aluno_id::text and m.tipo = 'FINALIZACAO_ATENDIMENTO'
                   and lower(m.registrado_por_email) = r.resp) as sem_atendimento_do_resp
  from retorno r
),

classificado as (
  select s.*,
    (s.resp_ativo and s.dia_campo is not null and s.ret <= s.dia_campo + 15) as via_campo,
    (s.resp_ativo and s.dia_texto is not null and s.ret <= s.dia_texto + 15) as via_texto,
    (s.resp_ativo and s.dia_alt   is not null)                                as via_alt
  from sinal s
),

caso as (
  select e.*, c.aluno_id is not null as tem_retorno,
         coalesce(c.via_campo, false) as via_campo,
         coalesce(c.via_texto, false) as via_texto,
         coalesce(c.via_alt,   false) as via_alt,
         coalesce(c.menciona_outra_data, false) as menciona_outra_data,
         coalesce(c.sem_atendimento_do_resp, false) as sem_atendimento_do_resp,
         coalesce(c.resp_ativo, true) as resp_ativo
    from elegivel e
    left join classificado c on c.aluno_id = e.aluno_id
),

final as (
  select *,
    (via_campo or via_texto or via_alt) as protegido,
    -- AMBÍGUO: tem retorno de operador vigente, NÃO está protegido, mas há sinal
    -- de que houve agendamento humano que não dá para amarrar à data vigente.
    (tem_retorno and not (via_campo or via_texto or via_alt)
       and (menciona_outra_data or sem_atendimento_do_resp)) as ambiguo
  from caso
)

select 'A. universo elegivel' as bloco, 'casos' as item, count(*)::text as valor from final
union all select 'A. universo elegivel', 'alunos', count(distinct aluno_id)::text from final
union all select 'A. universo elegivel', 'valor em aberto (R$)',
       coalesce(round(sum(public.saldo_titulos_aberto(cpf_limpo)))::text, '0') from final

union all select 'B. efeito da correcao de 13/11', 'com retorno de operador vigente', count(*)::text
  from final where tem_retorno
union all select 'B. efeito da correcao de 13/11', 'protegidos pelo CAMPO (formato novo)', count(*)::text
  from final where via_campo
union all select 'B. efeito da correcao de 13/11', 'RECUPERADOS pelo TEXTO (estoque antigo)', count(*)::text
  from final where via_texto and not via_campo
union all select 'B. efeito da correcao de 13/11', 'protegidos so pela alternativa de 10 dias', count(*)::text
  from final where via_alt and not via_campo and not via_texto
union all select 'B. efeito da correcao de 13/11', 'LIBERAVEIS (sem protecao e sem ambiguidade)', count(*)::text
  from final where not protegido and not ambiguo

union all select 'C. por responsavel', coalesce(split_part(operador, '@', 1), '(sem)') || ' — liberaveis',
       count(*)::text from final where not protegido and not ambiguo group by operador
union all select 'C. por responsavel', coalesce(split_part(operador, '@', 1), '(sem)') || ' — protegidos',
       count(*)::text from final where protegido group by operador

union all select 'D. AMBIGUOS (ficam FORA da liberacao)', 'total', count(*)::text
  from final where ambiguo
union all select 'D. AMBIGUOS (ficam FORA da liberacao)', 'texto do responsavel menciona OUTRA data', count(*)::text
  from final where ambiguo and menciona_outra_data
union all select 'D. AMBIGUOS (ficam FORA da liberacao)', 'nenhum atendimento do responsavel atual', count(*)::text
  from final where ambiguo and sem_atendimento_do_resp
order by 1, 2;

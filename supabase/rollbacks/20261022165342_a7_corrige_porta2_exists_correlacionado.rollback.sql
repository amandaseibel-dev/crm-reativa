-- ============================================================================
-- ROLLBACK da correcao do incidente da porta 2.
--
-- LEIA ANTES DE RODAR. Isto devolve `buscar_candidatos_acoes_massivas` ao
-- estado com DOIS `EXISTS` CORRELACIONADOS, que foi medido em producao em
-- 72.097 ms para 50 linhas. A tela Envio Gmail em lote pede 300 e PARA DE
-- FUNCIONAR. Em outras palavras: este rollback reintroduz o incidente.
--
-- Praticamente nunca e o que se quer. Se o objetivo for tirar a guarda da porta
-- 2, o caminho correto e o rollback do A7
-- (20261022120000_a7_contato_compartilhado_bloqueia_massiva.rollback.sql),
-- que remove a guarda inteira em vez de deixa-la lenta.
--
-- Existe por completude da trilha, e nao como opcao operacional.
--
-- ZERO DML na ida e na volta.
-- ============================================================================

do $rb$
declare
  v_src text;
  v_n int;
  r record;
begin
  for r in
    select * from (values
      -- desfaz (1.b): o WHERE volta ao NOT EXISTS
      (1,
$a$    -- A7: segunda porta. Esta tela envia E-MAIL pelo Gmail do operador.
    AND NOT coalesce(bl.email_bloqueado, false)$a$,
$b$    -- A7: segunda porta. Esta tela envia E-MAIL pelo Gmail do operador.
    AND NOT EXISTS (
      SELECT 1 FROM public.vw_contato_bloqueio b
       WHERE b.aluno_id = a.id AND b.canal = 'EMAIL'
    )$b$),
      -- desfaz (1.a): o SELECT volta ao EXISTS e o join agregado sai
      (1,
$a$  SELECT a.id, a.nome,
         -- A7: telefone bloqueado nao sai desta funcao.
         CASE WHEN coalesce(bl.tel_bloqueado, false) THEN NULL ELSE a.telefone END,
         a.email, a.data_ultimo_acionamento,
         COALESCE(c.total_em_aberto, 0) AS valor
  FROM public.alunos a
  LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
  -- A7 CORRECAO DO INCIDENTE: UMA leitura de vw_contato_bloqueio, agregada por
  -- aluno e unida por hash -- em vez de dois EXISTS correlacionados por linha.
  LEFT JOIN (
    select b.aluno_id,
           bool_or(b.canal = 'TELEFONE') as tel_bloqueado,
           bool_or(b.canal = 'EMAIL')    as email_bloqueado
      from public.vw_contato_bloqueio b
     group by b.aluno_id
  ) bl ON bl.aluno_id = a.id$a$,
$b$  SELECT a.id, a.nome,
         -- A7: telefone bloqueado nao sai desta funcao.
         CASE WHEN EXISTS (SELECT 1 FROM public.vw_contato_bloqueio b
                            WHERE b.aluno_id = a.id AND b.canal = 'TELEFONE')
              THEN NULL ELSE a.telefone END,
         a.email, a.data_ultimo_acionamento,
         COALESCE(c.total_em_aberto, 0) AS valor
  FROM public.alunos a
  LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL$b$)
    ) as t(ocorrencias, trecho, troca)
  loop
    select pg_get_functiondef(p.oid) into v_src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'buscar_candidatos_acoes_massivas'
     limit 1;
    if v_src is null then
      raise exception 'rollback: buscar_candidatos_acoes_massivas nao existe.';
    end if;

    v_n := (length(v_src) - length(replace(v_src, r.trecho, ''))) / length(r.trecho);
    if v_n = 0 then
      raise notice 'rollback: trecho ja ausente, nada a fazer.';
      continue;
    end if;
    if v_n <> r.ocorrencias then
      raise exception 'rollback: % ocorrencia(s) do trecho, esperado %. Revise a mao.', v_n, r.ocorrencias;
    end if;

    execute replace(v_src, r.trecho, r.troca);
  end loop;
end
$rb$;

-- Devolve o EXECUTE do plumbing a `authenticated`, como o default do schema
-- concedia. Nao havia exposicao de dado -- as duas funcoes sao IMMUTABLE,
-- recebem o valor por argumento e nao leem tabela.
grant execute on function public.contato_e_placeholder(text, text) to authenticated;
grant execute on function public.contato_tel_sem_ddi(text) to authenticated;

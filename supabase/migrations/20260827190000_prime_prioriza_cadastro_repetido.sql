-- Cadastro repetido entra na fila da Prime, e na frente.
--
-- Amanda, 27/08/2026, sobre os cadastros duplicados: "precisa confirmar no
-- prime".
--
-- O QUE FALTAVA. A conferencia depende de `prime_contratos`, que hoje cobre
-- 73,9% da base (12.857 dos 17.388 CPFs). Dos 233 cadastros envolvidos em nome
-- repetido, 158 estao confirmados na Prime e 75 nao -- mas "nao encontrado"
-- nao quer dizer "nao existe": pode ser so que a coleta ainda nao chegou nele.
--
-- E nao ia chegar. A fila da coleta (`prime_cadastro_pendentes`) so considera
-- quem tem TITULO EM ABERTO. Boa parte dos cadastros repetidos esta zerada --
-- e justamente o cadastro vazio que a gente precisa confirmar, para saber se
-- e pessoa de verdade ou CPF errado. Eles nunca entrariam na fila.
--
-- Passam a entrar, e na frente de tudo. Sao poucos (75), a coleta roda a cada
-- 2 minutos com 60 CPFs, entao a resposta sai em minutos, nao em dias.
--
-- COMO IDENTIFICA: nome normalizado (sem acento, sem espaco duplicado, em
-- maiuscula) que aparece em mais de um cadastro. Nome com menos de 13
-- caracteres fica de fora -- nome curto colide demais e traria homonimo real
-- para a frente da fila sem motivo.
--
-- O resto da ordem nao muda: sem telefone, depois 2026, depois sem
-- negociacao, depois maior saldo.
--
-- Conferido logo apos aplicar: dos 60 do proximo lote, 56 sao cadastros sem
-- divida entrando so para conferencia -- exatamente o que faltava.

create or replace function public.prime_cadastro_pendentes(p_limite integer default 50)
returns table(cpf text, saldo numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  WITH sem_negociacao AS MATERIALIZED (
    SELECT DISTINCT e.cpf FROM public._relatorio_2026_1_eleg() e
  ),
  devedores AS MATERIALIZED (
    SELECT lpad(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g'), 11, '0') AS cpf,
           round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)), 2) AS saldo,
           -- Prioridade da Amanda: quem tem parcela de 2026 em aberto vem antes.
           bool_or(extract(year from t.vencimento) = 2026) AS tem_2026
      FROM public.acordos_titulos t
     WHERE lower(coalesce(t.status,'')) = 'em_aberto'
       AND upper(coalesce(t.situacao,'')) = 'ABERTO'
       AND coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       AND length(regexp_replace(coalesce(t.cpf,''), '\D', '', 'g')) = 11
     GROUP BY 1
  ),
  -- Cadastro repetido: precisa ser confirmado na Prime para saber se e a mesma
  -- pessoa duas vezes ou dois homonimos. Entra mesmo sem divida em aberto --
  -- e o cadastro VAZIO que costuma ser o errado.
  repetidos AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
       AND length(coalesce(a.nome,'')) > 12
       AND EXISTS (
         SELECT 1 FROM public.alunos b
          WHERE b.id <> a.id
            AND length(coalesce(b.nome,'')) > 12
            AND upper(regexp_replace(translate(b.nome,
                  'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                  'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g'))
              = upper(regexp_replace(translate(a.nome,
                  'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                  'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g'))
       )
  ),
  candidatos AS MATERIALIZED (
    SELECT d.cpf, d.saldo, d.tem_2026 FROM devedores d
    UNION
    SELECT r.cpf, 0::numeric, false FROM repetidos r
     WHERE NOT EXISTS (SELECT 1 FROM devedores d2 WHERE d2.cpf = r.cpf)
  ),
  ja_coletados AS MATERIALIZED (
    SELECT DISTINCT c.cpf FROM public.prime_contratos c
     WHERE c.coletado_em > now() - interval '7 days'
  ),
  -- Sem telefone o aluno esta fora da operacao inteira: nao entra em acao
  -- massiva, nao recebe mensagem, nao e acionado. Consultar ele primeiro e o
  -- que devolve gente para a fila de trabalho.
  sem_telefone AS MATERIALIZED (
    SELECT DISTINCT lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') AS cpf
      FROM public.alunos a
     WHERE coalesce(a.telefone,'') = ''
       AND length(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g')) = 11
  )
  SELECT c.cpf, c.saldo
    FROM candidatos c
    LEFT JOIN sem_negociacao s ON s.cpf = c.cpf
    LEFT JOIN ja_coletados j   ON j.cpf = c.cpf
    LEFT JOIN sem_telefone st  ON st.cpf = c.cpf
    LEFT JOIN repetidos r      ON r.cpf = c.cpf
   WHERE j.cpf IS NULL
   ORDER BY (r.cpf IS NOT NULL) DESC,   -- cadastro repetido primeiro
            (st.cpf IS NOT NULL) DESC,
            c.tem_2026 DESC,
            (s.cpf IS NOT NULL) DESC,
            c.saldo DESC
   LIMIT greatest(1, least(coalesce(p_limite, 50), 500));
$function$;

-- Fila de Acordos: responsável ESPECÍFICO de cada acordo (somente leitura).
--
-- Problema:
--   A tela Fila de confirmação de acordos (src/pages/FilaAcordosConfirmar.jsx)
--   lê public.fila_acordos_confirmar, que é uma fila IMPORTADA de um sistema
--   externo. Essa tabela NÃO possui vínculo comprovado com public.acordos:
--     - não há coluna acordo_id;
--     - fila.acordo_base (ex.: '0505664400') é um código do sistema de origem
--       e NÃO corresponde a acordos.numero_acordo nem a acordos_titulos.documento
--       (0 correspondências verificadas);
--     - fila.operador_email NÃO é o responsável do acordo: é preenchido pela
--       própria tela quando o operador CONFIRMA/REJEITA o item da fila
--       (patch.operador_email = email do usuário logado). Usá-lo como
--       "responsável do acordo" seria incorreto.
--
--   A única sobreposição segura entre a fila e public.acordos é a tupla
--   (aluno_id, qtd_parcelas, valor_total).
--
-- Solução (somente CONSULTA/EXIBIÇÃO, sem duplicar dado de responsabilidade):
--   RPC de leitura que resolve, por linha da fila, o responsável CORRETO a
--   partir de public.acordos (operador_responsavel_nome / _email).
--   Resolução CONSERVADORA para nunca atribuir o responsável errado:
--     - só resolve quando existe EXATAMENTE UM acordo com a mesma tupla
--       (aluno_id, qtd_parcelas, valor_total);
--     - se houver 0 correspondências ou mais de uma (ambíguo), retorna NULL
--       -> a interface exibe "Sem responsável".
--   Nunca herda o responsável geral do aluno nem da carteira.
--
--   Não altera nenhum dado: não muda responsável do acordo/aluno, carteira,
--   distribuição, limite de 500, pagamentos, parcelas, valores ou status.
--   Não adiciona colunas nem faz backfill: apenas consulta acordos diretamente.
--
-- Segurança: SECURITY INVOKER + STABLE -> a RLS do usuário chamador é aplicada
--   a public.acordos e public.fila_acordos_confirmar (mesma visibilidade que a
--   tela já possui hoje). search_path fixo em 'public'.

create or replace function public.fila_acordos_responsavel()
  returns table (
    fila_id uuid,
    operador_responsavel_nome text,
    operador_responsavel_email text
  )
  language sql
  stable
  security invoker
  set search_path to 'public'
as $function$
  select
    f.id as fila_id,
    r.operador_responsavel_nome,
    r.operador_responsavel_email
  from public.fila_acordos_confirmar f
  left join lateral (
    -- Só devolve responsável quando a tupla identifica UM ÚNICO acordo.
    -- HAVING count(*) = 1 garante a linha única; min() apenas extrai o valor
    -- desse acordo (agregação obrigatória junto do HAVING sem GROUP BY).
    select min(a.operador_responsavel_nome)  as operador_responsavel_nome,
           min(a.operador_responsavel_email) as operador_responsavel_email
    from public.acordos a
    where a.aluno_id     = f.aluno_id
      and a.qtd_parcelas = f.qtd_parcelas
      and a.valor_total  = f.valor_total
    having count(*) = 1
  ) r on true;
$function$;

comment on function public.fila_acordos_responsavel() is
  'Somente leitura. Resolve o responsável ESPECÍFICO de cada acordo da fila '
  '(acordos.operador_responsavel_nome/_email) via a tupla (aluno_id, qtd_parcelas, '
  'valor_total), apenas quando há exatamente um acordo correspondente. Ambíguo/sem '
  'correspondência -> NULL. Não usa fila.operador_email nem o responsável do aluno.';

revoke all on function public.fila_acordos_responsavel() from public, anon;
grant execute on function public.fila_acordos_responsavel() to authenticated;

-- ROLLBACK:
--   drop function if exists public.fila_acordos_responsavel();

-- EVIDÊNCIA DE LEITURA DE PRODUÇÃO. NÃO EXECUTAR FORA DA FIXTURE DE TESTE (00_barreira_producao.sql, que a carrega por \i).
-- Executar em banco real substitui a função de produção: é proibido fora de um banco descartável de teste.
CREATE OR REPLACE FUNCTION public._encerramento_so_gestao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- PISO LITERAL -- nunca encolhe (ver FAIL-CLOSED no cabeçalho).
  -- + ANTECIPACAO_SEMESTRE (07/10/2026): passou a quitar parcela, virou
  --   decisao de gestao como cancelamento, suspensao e juridico.
  v_encerra text[] := array['CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA','JURIDICO','ANTECIPACAO_SEMESTRE','ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO','ALEGA_FINANCIAMENTO_CONFIRMADO'];
  v_catalogo text[];
  v_bloqueadas text[];
  v_tentou text;
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role'
                       or auth.jwt() is null
                       or session_user in ('postgres','reativa_responsavel_executor');
begin
  if v_sistema or coalesce(public.usuario_e_gestao(), false) then
    return new;
  end if;

  -- Catalogo: aqui dentro a RLS de `tabulacoes` nao filtra (SECURITY DEFINER,
  -- dona postgres, tabela sem FORCE ROW LEVEL SECURITY), entao `somente_gestao`
  -- e legivel por inteiro. `coalesce` para array vazio: leitura vazia nao pode
  -- virar NULL e anular o `&&` do piso.
  select coalesce(array_agg(upper(btrim(codigo))), '{}'::text[])
    into v_catalogo
    from public.tabulacoes
   where somente_gestao;

  -- UNIAO piso + catalogo. A regua so cresce.
  select coalesce(array_agg(distinct c), '{}'::text[])
    into v_bloqueadas
    from unnest(v_encerra || v_catalogo) as c
   where c <> '';

  -- POR COLUNA E POR CODIGO -- NUNCA por sobreposicao de conjuntos.
  --
  -- O gatilho original perguntava `(v_novo && v_bloqueadas) and not (v_antigo
  -- && v_bloqueadas)`, com arrays das tres colunas. `&&` e SOBREPOSICAO: bastava
  -- o aluno JA carregar qualquer codigo bloqueado, em qualquer das tres
  -- colunas, para o portao ser pulado para QUALQUER codigo novo -- inclusive um
  -- diferente. Enquanto a lista eram so os 7 estados TERMINAIS, a brecha era
  -- estreita. Ao acrescentar o catalogo ela deixaria de ser: `RETORNO_FINANCEIRO`
  -- e neutro e NAO terminal, a gestao vai carimba-lo na rotina em casos que
  -- seguem na carteira do operador -- e "aluno com retorno do financeiro"
  -- viraria a chave que destranca cancelamento, suspensao e juridico para o
  -- operador. Com efeito financeiro: `trg_tabulacao_efeito_financeiro` e AFTER
  -- UPDATE OF status_jornada, nao tem portao proprio (conferido em producao em
  -- 06/11/2026) e chama `parcela_efeito_sem_pagamento_aplicar`.
  --
  -- A pergunta certa e por COLUNA: esta coluna esta RECEBENDO AGORA um codigo
  -- bloqueado que ela nao tinha? Isso preserva o que importava na regra antiga
  -- -- reescrever o que ja estava la passa, e por isso os 182 alunos de
  -- producao que carregam codigo so-gestao continuam editaveis pelo operador --
  -- e fecha a brecha.
  --
  -- MAIS ESTRITO QUE ANTES EM DOIS PONTOS, declarados de propósito:
  --   1. trocar um codigo bloqueado por OUTRO (ex.: suspensao -> juridico)
  --      passa a ser barrado para quem nao e gestao;
  --   2. copiar um codigo bloqueado de uma coluna para outra tambem.
  -- Medido em producao em 06/11/2026: existem 8 transicoes entre codigos
  -- bloqueados no historico (`aluno_movimentacoes`), e TODAS AS 8 foram feitas
  -- pela gestao -- que passa pelo bypass acima. Logo nenhum fluxo real de
  -- operador e interrompido por este endurecimento.
  -- `btrim` NOS DOIS LADOS. `v_bloqueadas` normaliza com `upper(btrim(codigo))`;
  -- se aqui fosse só `upper()`, 'CANCELAMENTO_COBRANCA ' com espaco passaria o
  -- portao. No servidor o valor ficaria inerte (os consumidores comparam por
  -- igualdade exata), mas `casoNoKpi` em src/components/PainelCarteira.jsx
  -- classifica concatenando os status e olhando SUBSTRING -- o valor com espaco
  -- apareceria como encerrado na tela. Simetria e mais barata que a duvida.
  select x.novo into v_tentou
    from (values
            (upper(btrim(coalesce(new.status_atual,''))),
             case when tg_op = 'INSERT' then '' else upper(btrim(coalesce(old.status_atual,''))) end),
            (upper(btrim(coalesce(new.status_jornada,''))),
             case when tg_op = 'INSERT' then '' else upper(btrim(coalesce(old.status_jornada,''))) end),
            (upper(btrim(coalesce(new.status_acionamento,''))),
             case when tg_op = 'INSERT' then '' else upper(btrim(coalesce(old.status_acionamento,''))) end)
         ) as x(novo, antigo)
   where x.novo <> x.antigo
     and x.novo = any(v_bloqueadas)
   limit 1;

  if v_tentou is not null then
    if v_tentou = any(v_encerra) then
      -- Mensagem HISTORICA, palavra por palavra: os operadores a conhecem e
      -- ha teste ancorado nela.
      raise exception
        'Encerrar cobrança (cancelamento, suspensão, jurídico ou antecipação de semestre) é decisão da gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.'
        using errcode = '42501';
    else
      -- Tabulacao so-gestao que NAO encerra cobranca (ex.: RETORNO_FINANCEIRO).
      -- Dizer "encerrar cobranca" aqui seria mentir para o operador.
      raise exception
        'A tabulação "%" é restrita à gestão. Registre a solicitação para Amanda, Fernanda ou Amanda ADM.', v_tentou
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$

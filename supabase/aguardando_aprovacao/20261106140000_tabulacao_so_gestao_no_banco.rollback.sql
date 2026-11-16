-- ROLLBACK de 20261106140000_tabulacao_so_gestao_no_banco
--
-- Restaura o corpo de `_encerramento_so_gestao` EXATAMENTE como estava em
-- produção em 06/11/2026 (copiado de `pg_get_functiondef`, incluindo os três
-- `ALEGA_*_CONFIRMADO` que o repositório não registrava) e remove o gatilho de
-- INSERT, que não existia antes.
--
-- ATENÇÃO AO QUE ESTE ROLLBACK DEVOLVE: a lista volta a ser literal. Se neste
-- meio-tempo a tabulação `RETORNO_FINANCEIRO` tiver sido criada, ela deixa de
-- ser barrada no banco -- a proteção dela volta a ser só a do <select>. Então
-- este rollback só faz sentido junto com o rollback da tabulação
-- (20261106120000_tabulacao_retorno_financeiro.rollback.sql, que a desativa),
-- ou com a decisão consciente de voltar à restrição apenas por interface.
--
-- A trava de ENCERRAMENTO (cancelamento, suspensão, jurídico, antecipação e as
-- três confirmações de alegação) continua de pé depois deste rollback: ela está
-- no array literal, que é o que se restaura aqui.

begin;

create or replace function public._encerramento_so_gestao()
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
$function$;

comment on function public._encerramento_so_gestao() is null;

-- Mesmo ACL de 06/11/2026, pelo mesmo motivo do `.pendente`:
-- `create or replace` restaura o padrao do schema, que inclui PUBLIC.
revoke all on function public._encerramento_so_gestao() from public;
revoke all on function public._encerramento_so_gestao() from anon;
grant execute on function public._encerramento_so_gestao() to postgres, authenticated, service_role;

-- O gatilho de UPDATE continua; o de INSERT sai, porque nao existia antes.
drop trigger if exists trg_encerramento_so_gestao on public.alunos;
create trigger trg_encerramento_so_gestao
before update of status_atual, status_jornada, status_acionamento
on public.alunos
for each row execute function public._encerramento_so_gestao();

drop trigger if exists trg_tabulacao_so_gestao_insert on public.alunos;

-- VIGIA do rollback: §4 exige que rollback de função "restaura o texto exato
-- anterior e confere o md5 de volta". É isto -- se o md5 não voltar ao valor
-- medido em produção em 06/11/2026, a transcrição acima não é fiel e o rollback
-- não reverteu de verdade. E a trava de encerramento NÃO pode cair junto.
do $$
declare
  v_md5_original constant text := 'ae0382adc0eaf11fbe68d9ed0fc4a9b4';
  v_md5_atual text;
begin
  select md5(p.prosrc) into v_md5_atual
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = '_encerramento_so_gestao';

  if v_md5_atual is distinct from v_md5_original then
    raise exception
      'ROLLBACK md5: o corpo nao voltou ao original. esperado=% atual=%. O rollback NAO reverteu a funcao -- nao de por revertido.',
      v_md5_original, v_md5_atual;
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.alunos'::regclass
       and tgname = 'trg_encerramento_so_gestao' and not tgisinternal
  ) then
    raise exception 'rollback deixou public.alunos SEM a trava de encerramento';
  end if;
  if has_function_privilege('public', 'public._encerramento_so_gestao()', 'EXECUTE') then
    raise exception 'rollback deixou PUBLIC com EXECUTE em _encerramento_so_gestao';
  end if;
  if has_function_privilege('anon', 'public._encerramento_so_gestao()', 'EXECUTE') then
    raise exception 'rollback deixou anon com EXECUTE em _encerramento_so_gestao';
  end if;
  -- ACL completa: quem deve ter EXECUTE tem, e os demais nao.
  if not (has_function_privilege('postgres', 'public._encerramento_so_gestao()', 'EXECUTE')
      and has_function_privilege('authenticated', 'public._encerramento_so_gestao()', 'EXECUTE')
      and has_function_privilege('service_role', 'public._encerramento_so_gestao()', 'EXECUTE')) then
    raise exception 'rollback: ACL de _encerramento_so_gestao diferente de postgres/authenticated/service_role';
  end if;
end
$$;

commit;

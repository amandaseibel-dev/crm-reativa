-- ============================================================================
-- ROLLBACK do A7 — contato compartilhado bloqueia acao massiva
--
-- CONFERIR ANTES DE RODAR. O estado de producao em 22/10/2026, ANTES do A7:
--   acoes_massivas_universo        md5 425a3961a1479ac91f0a6e00218bc66c
--                                  length 14.609  linhas 276
-- Se esse md5 NAO bater com producao no momento do rollback, alguem alterou a
-- funcao depois do A7 e desfazer por aqui apagaria a mudanca dessa pessoa.
-- Nesse caso, PARE e desfaca apenas o trecho do A7 a mao.
--
-- ESTE ROLLBACK DESFAZ O PATCH, NAO REESCREVE A FUNCAO. Remove exatamente os
-- trechos que a ida acrescentou, pelo mesmo mecanismo ancorado -- assim um
-- patch de terceiro aplicado no meio-tempo e preservado.
--
-- EFEITO: as acoes massivas voltam a enviar para contato compartilhado entre
-- pessoas diferentes e para contato marcado como invalido em aluno_contatos.
-- Medido em 22/10/2026, isso devolve ao envio 251 fichas em 85 telefones e 151
-- fichas em 57 e-mails -- inclusive um numero em 30 fichas. Em outubro, 32
-- numeros receberam mensagem sobre 107 pessoas diferentes por esse caminho.
--
-- ZERO DML. Nenhum dado de aluno, contato, saldo, acordo ou pagamento muda --
-- nem na ida nem na volta. Em particular, as marcas de contato invalido que
-- operadores tenham feito via `contato_sinalizar_incorreto` CONTINUAM gravadas
-- em `aluno_contatos`; elas apenas deixam de ter efeito sobre o envio, que era
-- o comportamento anterior ao A7.
-- ============================================================================

-- NOTA SOBRE O MECANISMO. `internal.patch_funcao_ancorada` serve apenas para
-- patch ADITIVO: ela recusa de proposito o caso em que o texto novo e pedaco
-- da ancora ("patch ambiguo"), que e exatamente a forma de uma REMOCAO. Entao
-- a volta usa o bloco abaixo, com as mesmas guardas adaptadas para remover:
--   * conta as ocorrencias do trecho do A7; se for 0, avisa e nao faz nada
--     (idempotente, pode rodar duas vezes);
--   * se for diferente do esperado, FALHA -- a funcao mudou e precisa de olho
--     humano;
--   * so entao reescreve a funcao sem o trecho, preservando tudo o mais.
do $rb$
declare
  v_src text;
  v_n int;
  r record;
begin
  for r in
    select * from (values
      -- (1) Porta 1 -- os tres acrescimos no universo, do mais interno para fora
      ('acoes_massivas_universo', 2,
$a$                when e.f_ctt_bl then e.mot_ctt_bl
$a$,
$b$$b$),
      ('acoes_massivas_universo', 1,
$a$           -- A7: bloqueio do canal deste lote.
           case when v_canal = 'WHATSAPP' then z.f_tel_bl
                when v_canal = 'EMAIL' then z.f_mail_bl
                else false end as f_ctt_bl,
           case when v_canal = 'WHATSAPP' then z.mot_tel_bl
                when v_canal = 'EMAIL' then z.mot_mail_bl
                else null end as mot_ctt_bl,
$a$,
$b$$b$),
      ('acoes_massivas_universo', 1,
$a$ as f_val,
           -- A7: contato compartilhado entre pessoas, ou marcado invalido.
           -- LEFT JOIN e nao EXISTS correlacionado: neste banco um EXISTS
           -- correlacionado dentro de CTE materializado ja custou 35 s.
           (bt.aluno_id is not null) as f_tel_bl, bt.motivo as mot_tel_bl,
           (be.aluno_id is not null) as f_mail_bl, be.motivo as mot_mail_bl
      from cls k
      left join public.vw_contato_bloqueio bt
             on bt.aluno_id = k.id and bt.canal = 'TELEFONE'
      left join public.vw_contato_bloqueio be
             on be.aluno_id = k.id and be.canal = 'EMAIL'$a$,
$b$ as f_val
      from cls k$b$),
      -- (2) Porta 2 -- os dois acrescimos na tela de Gmail
      ('buscar_candidatos_acoes_massivas', 1,
$a$  SELECT a.id, a.nome,
         -- A7: telefone bloqueado nao sai desta funcao.
         CASE WHEN EXISTS (SELECT 1 FROM public.vw_contato_bloqueio b
                            WHERE b.aluno_id = a.id AND b.canal = 'TELEFONE')
              THEN NULL ELSE a.telefone END,
         a.email,$a$,
$b$  SELECT a.id, a.nome, a.telefone, a.email,$b$),
      ('buscar_candidatos_acoes_massivas', 1,
$a$
    -- A7: segunda porta. Esta tela envia E-MAIL pelo Gmail do operador.
    AND NOT EXISTS (
      SELECT 1 FROM public.vw_contato_bloqueio b
       WHERE b.aluno_id = a.id AND b.canal = 'EMAIL'
    )$a$,
$b$$b$),
      -- (3) Consolidacao nas RPCs existentes -- VOLTA AO ESTADO ABERTO.
      -- ATENCAO: desfazer 14.b devolve a reativacao de contato a QUALQUER
      -- operador ativo, e desfazer 14.c volta a APAGAR o motivo. E o estado
      -- anterior ao A7, nao um estado seguro.
      ('aluno_contato_invalidar', 1,
$a$

  -- A7/decisao 1: motivo obrigatorio. O contato invalidado bloqueia o canal na
  -- acao massiva, e bloqueio sem motivo nao pode ser revisado por ninguem.
  IF nullif(btrim(coalesce(p_motivo, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Motivo obrigatorio ao invalidar contato.' USING ERRCODE='22023';
  END IF;$a$,
$b$$b$),
      ('aluno_contato_revalidar', 1,
$a$  IF coalesce(auth.role(),'') <> 'service_role'
     AND NOT public.usuario_pode_revalidar_contato() THEN
    RAISE EXCEPTION 'Acesso negado: reativar contato e exclusivo do Administrativo ou da supervisao.'
      USING ERRCODE='42501';
  END IF;$a$,
$b$  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE='42501';
  END IF;$b$),
      ('aluno_contato_revalidar', 1,
$a$     SET valido = true, invalidado_em = null, invalidado_por_email = null,
         motivo_invalidacao = 'REATIVADO por ' || lower(coalesce(auth.email(), '?')) || ' em '
           || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
           || coalesce(' | antes: ' || motivo_invalidacao, '')$a$,
$b$     SET valido = true, invalidado_em = null, invalidado_por_email = null, motivo_invalidacao = null$b$),
      -- (4) Rotulos
      ('acoes_massivas_motivo_texto', 1,
$a$    when 'contato_compartilhado' then 'Outra pessoa com dívida usa o mesmo contato — em revisão cadastral'
    when 'contato_invalidado'    then 'Contato marcado como incorreto — liberação pelo Administrativo'
$a$,
$b$$b$)
    ) as t(funcao, ocorrencias, trecho, troca)
  loop
    select pg_get_functiondef(p.oid) into v_src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.funcao
     limit 1;
    if v_src is null then
      raise exception 'rollback A7: public.% nao existe.', r.funcao;
    end if;

    v_n := (length(v_src) - length(replace(v_src, r.trecho, ''))) / length(r.trecho);
    if v_n = 0 then
      raise notice 'rollback A7: % ja estava sem este trecho.', r.funcao;
      continue;
    end if;
    if v_n <> r.ocorrencias then
      raise exception 'rollback A7: public.% tem % ocorrencia(s) do trecho do A7, esperado %. A funcao mudou; revise a mao.',
        r.funcao, v_n, r.ocorrencias;
    end if;

    execute replace(v_src, r.trecho, r.troca);
  end loop;
end
$rb$;

-- (4) As pecas proprias do A7. Dropadas por ultimo, porque as funcoes acima
--     referenciam `vw_contato_bloqueio` -- enquanto o patch nao sair, a view
--     nao pode cair.
--
--     As marcas ja gravadas em `aluno_contatos` FICAM: zero DML na volta.
drop function if exists public.contato_fila_revisao(text, integer);
drop function if exists public.usuario_pode_revalidar_contato();
drop view if exists public.vw_contato_bloqueio;
drop view if exists public.vw_contato_invalidado;
drop view if exists public.vw_contato_compartilhado;
drop view if exists public.vw_contato_normalizado;
drop function if exists public.contato_e_placeholder(text, text);
drop function if exists public.contato_tel_sem_ddi(text);

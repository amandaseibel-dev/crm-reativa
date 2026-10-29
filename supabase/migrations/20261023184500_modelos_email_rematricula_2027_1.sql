-- Modelos de e-mail da rematricula 2027/1 + "Reta final" sai das opcoes ativas.
--
-- Pedido da gestao em 23/10/2026:
--   1. localizar "Reta Final de Rematricula" e retirar das opcoes ativas,
--      PRESERVANDO os historicos de envio;
--   2. acrescentar dois modelos novos para 2027/1;
--   3. ambos disponiveis para os operadores, no envio individual e nas acoes
--      massivas, sem disparar e-mail automaticamente;
--   4. nao alterar os demais modelos nem outras campanhas.
--
-- ---------------------------------------------------------------------------
-- COMO ISSO FUNCIONA NESTE CRM (lido no codigo, nao suposto)
-- ---------------------------------------------------------------------------
--
-- As tres telas que oferecem arte de e-mail leem `email_templates` com
-- `.eq("ativo", true).order("ordem")`:
--
--   - `src/components/EmailAlunoUnificado.jsx`  -> envio INDIVIDUAL, na ficha
--   - `src/pages/EnvioGmailLote.jsx`            -> envio em LOTE (acao massiva)
--   - `src/components/AvisoTemplateNovo.jsx`    -> aviso de modelo novo (`novo`)
--
-- Entao `ativo = false` tira o modelo das DUAS portas de envio e `ativo = true`
-- o coloca nas duas, sem uma linha de codigo novo. Nenhum envio e disparado por
-- esta migration: quem envia e o operador, pelo Gmail dele.
--
-- POR QUE O HISTORICO ESTA PRESERVADO POR CONSTRUCAO.
-- O historico de envio e gravado em `aluno_movimentacoes` como TEXTO LIVRE:
--   tipo      = 'ACAO_MASSIVA_EXTERNA_EMAIL'
--   descricao = 'E-mail (<situacao>) enviado por <operador>...'
-- Nao existe chave estrangeira, `template_id` nem coluna `chave` ligando as
-- duas tabelas. Logo, mexer em `email_templates` NAO PODE alterar nem apagar
-- uma linha de historico. Medido em PROD em 23/10/2026: 171 envios de "Reta
-- final das rematriculas" (o ultimo em 22/10/2026 22:39 UTC), de 15.834 envios
-- de e-mail no total. Os 171 continuam intactos depois desta migration.
--
-- E por isso a `situacao` da linha antiga NAO e tocada: ela e o rotulo que o
-- historico ja gravou 171 vezes. Mudar o rotulo agora faria a linha divergir
-- do que o historico diz. So o `ativo` muda -- mesmo padrao de
-- 20260902170000_arte_de_rematricula_sai_da_ficha.sql.
--
-- NAO E EXCLUSAO: a linha `reta_final_matricula` continua na tabela com
-- assunto e corpo intactos. Para trazer de volta, `ativo = true` basta.
--
-- Guarda `if` de tabela porque `email_templates` so existe em producao hoje
-- (mesma razao da migration de 02/09): sem a guarda, a migration quebraria em
-- qualquer banco local ou de CI.
--
-- `id` e GENERATED ALWAYS AS IDENTITY -- nunca informado no insert.
-- `chave` e UNIQUE, entao o `on conflict` deixa a migration reaplicavel.
--
-- ORDEM: os dois novos entram em 7 e 8, depois do ultimo existente (6), para
-- que NENHUM modelo atual mude de posicao na lista do operador. A visibilidade
-- vem de `novo = true`, que e o mecanismo que o CRM ja tem para anunciar modelo
-- novo (`AvisoTemplateNovo`).
--
-- EFEITO COLATERAL DECLARADO: `novas_condicoes_negociacao` esta hoje com
-- `novo = true`. O aviso monta a chave de "ja vi" a partir da lista ordenada de
-- modelos novos, entao ao entrarem dois modelos a lista muda e o aviso reaparece
-- citando os tres. Nao foi corrigido de proposito -- a gestao pediu para NAO
-- alterar os demais modelos, e baixar o `novo` do outro seria alterar.

do $$
begin
  if to_regclass('public.email_templates') is null then
    raise notice 'email_templates nao existe neste banco -- nada a fazer.';
    return;
  end if;

  -- 1) "Reta final das rematriculas" sai das opcoes ativas. Texto e historico
  --    permanecem; so a visibilidade muda.
  update public.email_templates
     set ativo = false
   where chave = 'reta_final_matricula';

  -- 2) Modelo 1 -- "garanta sua vaga"
  insert into public.email_templates
    (chave, situacao, ordem, assunto, corpo_html, corpo_texto,
     permite_anexo, ativo, dias_retorno, novo)
  values (
    'rematricula_2027_1_vaga',
    'Rematrícula 2027/1 — garanta sua vaga',
    7,
    '💙 Seu próximo semestre começa aqui! Rematrículas 2027/1 abertas',
    $html$<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a"><div style="background:#ffffff;padding:22px 20px;border:1px solid #e5e7eb;border-bottom:none;border-radius:12px 12px 0 0;text-align:center"><img src="https://crm-reativa.vercel.app/logo_padrao_email.png" alt="ReATIVA" width="200" style="display:inline-block;width:200px;max-width:200px;height:auto;border:0;outline:none;text-decoration:none"></div><div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px;line-height:1.5"><div style="background:#1e3a8a;border-radius:10px;padding:16px 18px;text-align:center;color:#ffffff"><div style="font-size:20px;font-weight:800;letter-spacing:0.3px">REMATRÍCULAS 2027/1 ABERTAS</div><div style="margin-top:6px;font-size:14px;color:#dbeafe">seu próximo semestre <strong style="color:#facc15">começa aqui</strong></div></div><p style="margin-top:18px">Olá, <strong>{{nome}}</strong>!</p><p>As rematrículas para o semestre 2027/1 já estão abertas, e queremos te ajudar a garantir sua vaga para o próximo semestre! 💙</p><p>Estamos com condições especiais de negociação para facilitar esse processo. Entre em contato conosco e vamos encontrar a melhor opção para você continuar sua jornada acadêmica! 🎓✨</p><p style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;text-align:center;font-weight:700">✉️ Responda este e-mail para falar com a nossa equipe.</p><p style="color:#64748b;font-size:13px">Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.</p><div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef2f6"><a href="https://wa.me/5551999154925" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">💬 WhatsApp (51) 99915-4925</a> <a href="tel:+555134779218" style="display:inline-block;margin-left:8px;background:#1e40af;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">📞 Ligações (51) 3477-9218</a></div><p style="color:#64748b;font-size:13px;margin-top:14px">Atendimento seguro e oficial em parceria com a ULBRA.<br>Atenciosamente,<br><strong>Equipe ReATIVA</strong> — Atendimento ULBRA</p></div></div>$html$,
    $txt$REMATRÍCULAS 2027/1 ABERTAS — seu próximo semestre começa aqui

Olá, {{nome}}!

As rematrículas para o semestre 2027/1 já estão abertas, e queremos te ajudar a garantir sua vaga para o próximo semestre! 💙

Estamos com condições especiais de negociação para facilitar esse processo. Entre em contato conosco e vamos encontrar a melhor opção para você continuar sua jornada acadêmica! 🎓✨

Responda este e-mail para falar com a nossa equipe.

Prefere falar agora? WhatsApp (51) 99915-4925 (abrir: https://wa.me/5551999154925) ou Ligações (51) 3477-9218.

Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.

Atendimento seguro e oficial em parceria com a ULBRA.
Atenciosamente,
Equipe ReATIVA — Atendimento ULBRA$txt$,
    false, true, 7, true
  )
  on conflict (chave) do update
     set situacao     = excluded.situacao,
         ordem        = excluded.ordem,
         assunto      = excluded.assunto,
         corpo_html   = excluded.corpo_html,
         corpo_texto  = excluded.corpo_texto,
         permite_anexo = excluded.permite_anexo,
         ativo        = excluded.ativo,
         dias_retorno = excluded.dias_retorno,
         novo         = excluded.novo;

  -- 3) Modelo 2 -- "confira suas condicoes especiais"
  insert into public.email_templates
    (chave, situacao, ordem, assunto, corpo_html, corpo_texto,
     permite_anexo, ativo, dias_retorno, novo)
  values (
    'rematricula_2027_1_condicoes',
    'Rematrícula 2027/1 — condições especiais',
    8,
    '🎓 Rematrículas 2027/1 abertas: confira suas condições especiais!',
    $html$<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a"><div style="background:#ffffff;padding:22px 20px;border:1px solid #e5e7eb;border-bottom:none;border-radius:12px 12px 0 0;text-align:center"><img src="https://crm-reativa.vercel.app/logo_padrao_email.png" alt="ReATIVA" width="200" style="display:inline-block;width:200px;max-width:200px;height:auto;border:0;outline:none;text-decoration:none"></div><div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;padding:20px;line-height:1.5"><div style="background:#1e3a8a;border-radius:10px;padding:16px 18px;text-align:center;color:#ffffff"><div style="font-size:20px;font-weight:800;letter-spacing:0.3px">REMATRÍCULAS 2027/1 ABERTAS</div><div style="margin-top:6px;font-size:14px;color:#dbeafe">confira suas <strong style="color:#facc15">condições especiais</strong></div></div><p style="margin-top:18px">Olá, <strong>{{nome}}</strong>!</p><p>🎓 As rematrículas para o semestre 2027/1 já estão abertas!</p><p>Aproveite nossas condições especiais de negociação e regularize sua situação para garantir sua vaga no próximo semestre. Entre em contato conosco e saiba mais! 💙</p><p style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;text-align:center;font-weight:700">✉️ Responda este e-mail para falar com a nossa equipe.</p><p style="color:#64748b;font-size:13px">Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.</p><div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef2f6"><a href="https://wa.me/5551999154925" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">💬 WhatsApp (51) 99915-4925</a> <a href="tel:+555134779218" style="display:inline-block;margin-left:8px;background:#1e40af;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-weight:700">📞 Ligações (51) 3477-9218</a></div><p style="color:#64748b;font-size:13px;margin-top:14px">Atendimento seguro e oficial em parceria com a ULBRA.<br>Atenciosamente,<br><strong>Equipe ReATIVA</strong> — Atendimento ULBRA</p></div></div>$html$,
    $txt$REMATRÍCULAS 2027/1 ABERTAS — confira suas condições especiais

Olá, {{nome}}!

🎓 As rematrículas para o semestre 2027/1 já estão abertas!

Aproveite nossas condições especiais de negociação e regularize sua situação para garantir sua vaga no próximo semestre. Entre em contato conosco e saiba mais! 💙

Responda este e-mail para falar com a nossa equipe.

Prefere falar agora? WhatsApp (51) 99915-4925 (abrir: https://wa.me/5551999154925) ou Ligações (51) 3477-9218.

Caso o pagamento já tenha sido realizado, por favor, desconsidere esta mensagem.

Atendimento seguro e oficial em parceria com a ULBRA.
Atenciosamente,
Equipe ReATIVA — Atendimento ULBRA$txt$,
    false, true, 7, true
  )
  on conflict (chave) do update
     set situacao     = excluded.situacao,
         ordem        = excluded.ordem,
         assunto      = excluded.assunto,
         corpo_html   = excluded.corpo_html,
         corpo_texto  = excluded.corpo_texto,
         permite_anexo = excluded.permite_anexo,
         ativo        = excluded.ativo,
         dias_retorno = excluded.dias_retorno,
         novo         = excluded.novo;
end $$;

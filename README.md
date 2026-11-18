# Resenhudo

A súmula oficial da pelada: Craque, Bagre, Desculpa da Rodada e Mãe Diná, com súmula e figurinhas prontas para o WhatsApp.

## Estrutura
- `index.html`, `styles.css`, `app.js`: o app (site estático, sem build).
- `config.js`: URL do Supabase e chave **publishable** (pública por design).
- `supabase/schema.sql`: banco de dados. Rode uma vez no SQL Editor do Supabase.

## Segurança
- Nenhuma tabela é acessível direto pela chave pública: tudo passa por funções que exigem o código da pelada.
- Ações de organizador exigem o PIN (bloqueio de 15 min após 5 erros).
- Nunca coloque a chave `secret`/`service_role` neste repositório.

## Deploy
Vercel → Add New Project → importar este repositório → Framework: **Other** → Deploy.

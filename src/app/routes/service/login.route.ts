import { Routes } from "@angular/router";
import { LoginGuard } from "src/app/core/guards";

export const authRoutes: Routes = [
    {
        path: '',
        loadComponent: () => import('../../pages/service/login/login.component').then(m => m.LoginComponent),
        data: {
            title: 'login',
            animation: 'login'
        },
        canActivate: [LoginGuard],
        canActivateChild: [LoginGuard]
    }
];